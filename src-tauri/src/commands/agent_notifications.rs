//! System notifications for agent alerts: at most one per task, and one per automation Inbox
//! entry, delivered without waiting for the user. Clicks reach the app through a notification
//! center delegate, and a task's notification is replaced by its next alert and removed once the
//! task no longer needs attention.

#[cfg(not(any(target_os = "macos", windows)))]
use tauri::{AppHandle, Runtime};

use super::agent_alerts::NotificationTarget;

#[cfg(target_os = "macos")]
const IDENTIFIER_PREFIX: &str = "wtm-agent-task:";
#[cfg(target_os = "macos")]
const INBOX_IDENTIFIER_PREFIX: &str = "wtm-automation-inbox:";
#[cfg(target_os = "macos")]
const TARGET_KEY: &str = "target";

#[cfg(target_os = "macos")]
fn task_identifier(task_id: &str) -> String {
    format!("{IDENTIFIER_PREFIX}{task_id}")
}

/// An Inbox entry's notification never replaces, nor is removed with, its task's alerts.
#[cfg(target_os = "macos")]
fn notification_identifier(target: &NotificationTarget) -> String {
    match &target.inbox_entry {
        Some(entry) => format!("{INBOX_IDENTIFIER_PREFIX}{entry}"),
        None => task_identifier(&target.task_id),
    }
}

#[cfg(target_os = "macos")]
fn notifies_task(identifier: &str, task_ids: &[String]) -> bool {
    identifier
        .strip_prefix(IDENTIFIER_PREFIX)
        .is_some_and(|task_id| task_ids.iter().any(|id| id == task_id))
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, ClassType, DefinedClass};
    use objc2_foundation::{
        NSDictionary, NSString, NSUserNotification, NSUserNotificationCenter,
        NSUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Runtime};

    use super::{notification_identifier, notifies_task, NotificationTarget, TARGET_KEY};
    use crate::commands::agent_alerts::reveal_target;

    type OpenTarget = Box<dyn Fn(NotificationTarget)>;

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "WTMAgentNotificationDelegate"]
        #[ivars = OpenTarget]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _center: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                true
            }

            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(
                &self,
                center: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                if let Some(target) = stored_target(notification) {
                    self.ivars()(target);
                }
                center.removeDeliveredNotification(notification);
            }
        }
    );

    fn stored_target(notification: &NSUserNotification) -> Option<NotificationTarget> {
        let json = notification
            .userInfo()?
            .objectForKey(&NSString::from_str(TARGET_KEY))?
            .downcast::<NSString>()
            .ok()?
            .to_string();
        serde_json::from_str(&json).ok()
    }

    /// Unbundled dev builds borrow the app's bundle identifier, without which there is no
    /// notification center.
    fn center<R: Runtime>(app: &AppHandle<R>) -> Option<Retained<NSUserNotificationCenter>> {
        #[cfg(test)]
        if let Some(center) = super::tests::fake_center() {
            return Some(center);
        }
        let _ = mac_notification_sys::set_application(&app.config().identifier);
        unsafe {
            msg_send![
                NSUserNotificationCenter::class(),
                defaultUserNotificationCenter
            ]
        }
    }

    /// The center does not retain its delegate, so it is kept alive for the app's lifetime.
    fn ensure_delegate<R: Runtime>(app: &AppHandle<R>, center: &NSUserNotificationCenter) {
        if unsafe { center.delegate() }.is_some() {
            return;
        }
        let app = app.clone();
        let open: OpenTarget = Box::new(move |target| reveal_target(&app, &target));
        let delegate = Delegate::alloc().set_ivars(open);
        let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
        unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
        std::mem::forget(delegate);
    }

    fn remove_for_tasks(center: &NSUserNotificationCenter, task_ids: &[String]) {
        for notification in center.deliveredNotifications() {
            let identifier = notification.identifier().map(|id| id.to_string());
            if identifier.is_some_and(|id| notifies_task(&id, task_ids)) {
                center.removeDeliveredNotification(&notification);
            }
        }
    }

    fn notification(
        title: &str,
        body: &str,
        target: &NotificationTarget,
    ) -> Retained<NSUserNotification> {
        let notification = NSUserNotification::new();
        let identifier = NSString::from_str(&notification_identifier(target));
        notification.setIdentifier(Some(&identifier));
        notification.setTitle(Some(&NSString::from_str(title)));
        notification.setInformativeText(Some(&NSString::from_str(body)));
        let target_json = NSString::from_str(&serde_json::to_string(target).unwrap_or_default());
        let user_info = NSDictionary::<NSString, AnyObject>::from_slices(
            &[&*NSString::from_str(TARGET_KEY)],
            &[&**target_json],
        );
        unsafe { notification.setUserInfo(Some(&user_info)) };
        notification
    }

    fn on_center<R: Runtime>(
        app: &AppHandle<R>,
        action: impl FnOnce(&NSUserNotificationCenter) + Send + 'static,
    ) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(center) = center(&handle) {
                ensure_delegate(&handle, &center);
                action(&center);
            }
        });
    }

    pub fn deliver<R: Runtime>(
        app: &AppHandle<R>,
        title: String,
        body: String,
        target: NotificationTarget,
    ) {
        on_center(app, move |center| {
            if target.inbox_entry.is_none() {
                remove_for_tasks(center, std::slice::from_ref(&target.task_id));
            }
            center.deliverNotification(&notification(&title, &body, &target));
        });
    }

    pub fn dismiss<R: Runtime>(app: &AppHandle<R>, task_ids: Vec<String>) {
        on_center(app, move |center| remove_for_tasks(center, &task_ids));
    }
}

#[cfg(target_os = "macos")]
pub use macos::{deliver, dismiss};

/// Windows toast notifications. A task's toast carries a tag derived from its id in the "task"
/// group, so the next alert replaces it and `dismiss` removes it from the Action Center; Inbox
/// entries use their own group. Clicks reach the app through each toast's `Activated` handler.
#[cfg(windows)]
mod windows_toast {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock, PoisonError};

    use tauri::{AppHandle, Runtime};
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    use super::NotificationTarget;
    use crate::commands::agent_alerts::reveal_target;

    const TASK_GROUP: &str = "task";
    const INBOX_GROUP: &str = "inbox";

    /// Shown toasts, kept alive so their click handlers stay registered until replaced or
    /// dismissed.
    static SHOWN: Mutex<Option<HashMap<String, ToastNotification>>> = Mutex::new(None);

    /// Toast tags are limited to 64 characters; a digest keeps any id within that.
    fn tag(id: &str) -> String {
        format!("{:x}", md5::compute(id))
    }

    fn tag_and_group(target: &NotificationTarget) -> (String, &'static str) {
        match &target.inbox_entry {
            Some(entry) => (tag(entry), INBOX_GROUP),
            None => (tag(&target.task_id), TASK_GROUP),
        }
    }

    /// The AppUserModelID toasts are sent under. Unpackaged apps register one per user under
    /// `HKCU\Software\Classes\AppUserModelId` so Windows shows the app's name on its toasts.
    fn app_id<R: Runtime>(app: &AppHandle<R>) -> HSTRING {
        static REGISTERED: OnceLock<String> = OnceLock::new();
        let id = REGISTERED.get_or_init(|| {
            let id = app.config().identifier.clone();
            let key = format!(r"HKCU\Software\Classes\AppUserModelId\{id}");
            let name = app.package_info().name.clone();
            let mut command = std::process::Command::new("reg");
            let registered = crate::platform::hide_console(&mut command)
                .args([
                    "add",
                    &key,
                    "/v",
                    "DisplayName",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &name,
                    "/f",
                ])
                .output()
                .is_ok_and(|output| output.status.success());
            if !registered {
                log::warn!("Could not register the notification app id {id}");
            }
            id
        });
        HSTRING::from(id.as_str())
    }

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    fn show<R: Runtime>(
        app: &AppHandle<R>,
        title: &str,
        body: &str,
        target: NotificationTarget,
    ) -> windows::core::Result<()> {
        let (tag, group) = tag_and_group(&target);
        let xml = XmlDocument::new()?;
        // The app plays its own alert sound, so the toast stays silent.
        xml.LoadXml(&HSTRING::from(format!(
            r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual><audio silent="true"/></toast>"#,
            escape(title),
            escape(body)
        )))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        toast.SetTag(&HSTRING::from(&tag))?;
        toast.SetGroup(&HSTRING::from(group))?;
        let handle = app.clone();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            reveal_target(&handle, &target);
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&app_id(app))?.Show(&toast)?;
        SHOWN
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert_with(HashMap::new)
            .insert(format!("{group}:{tag}"), toast);
        Ok(())
    }

    pub fn deliver<R: Runtime>(
        app: &AppHandle<R>,
        title: String,
        body: String,
        target: NotificationTarget,
    ) {
        if let Err(error) = show(app, &title, &body, target) {
            log::warn!("Could not show a notification: {error}");
        }
    }

    pub fn dismiss<R: Runtime>(app: &AppHandle<R>, task_ids: Vec<String>) {
        let id = app_id(app);
        let history = ToastNotificationManager::History();
        let mut shown = SHOWN.lock().unwrap_or_else(PoisonError::into_inner);
        for task_id in task_ids {
            let tag = tag(&task_id);
            if let Ok(history) = &history {
                let _ = history.RemoveGroupedTagWithId(
                    &HSTRING::from(&tag),
                    &HSTRING::from(TASK_GROUP),
                    &id,
                );
            }
            if let Some(shown) = shown.as_mut() {
                shown.remove(&format!("{TASK_GROUP}:{tag}"));
            }
        }
    }
}

#[cfg(windows)]
pub use windows_toast::{deliver, dismiss};

#[cfg(not(any(target_os = "macos", windows)))]
pub fn deliver<R: Runtime>(
    _app: &AppHandle<R>,
    _title: String,
    _body: String,
    _target: NotificationTarget,
) {
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn dismiss<R: Runtime>(_app: &AppHandle<R>, _task_ids: Vec<String>) {}

#[cfg(all(test, target_os = "macos"))]
#[allow(deprecated)]
pub(crate) mod tests {
    use std::cell::RefCell;
    use std::sync::{Arc, Mutex};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass, Message};
    use objc2_foundation::{NSArray, NSUserNotification, NSUserNotificationCenter};
    use serde_json::{json, Value};
    use tauri::Listener;

    use super::*;
    use crate::commands::agent_alerts::NOTIFICATION_OPEN_EVENT;

    #[derive(Default)]
    struct FakeCenterState {
        delivered: RefCell<Vec<Retained<NSUserNotification>>>,
        delegate: RefCell<Option<Retained<AnyObject>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "WTMFakeNotificationCenter"]
        #[ivars = FakeCenterState]
        struct FakeCenter;

        impl FakeCenter {
            #[unsafe(method_id(deliveredNotifications))]
            fn delivered_notifications(&self) -> Retained<NSArray<NSUserNotification>> {
                NSArray::from_retained_slice(&self.ivars().delivered.borrow())
            }

            #[unsafe(method(deliverNotification:))]
            fn deliver_notification(&self, notification: &NSUserNotification) {
                self.ivars().delivered.borrow_mut().push(notification.retain());
            }

            #[unsafe(method(removeDeliveredNotification:))]
            fn remove_delivered_notification(&self, notification: &NSUserNotification) {
                self.ivars()
                    .delivered
                    .borrow_mut()
                    .retain(|delivered| !std::ptr::eq(&**delivered, notification));
            }

            #[unsafe(method_id(delegate))]
            fn delegate(&self) -> Option<Retained<AnyObject>> {
                self.ivars().delegate.borrow().clone()
            }

            #[unsafe(method(setDelegate:))]
            fn set_delegate(&self, delegate: Option<&AnyObject>) {
                *self.ivars().delegate.borrow_mut() = delegate.map(AnyObject::retain);
            }
        }
    );

    thread_local! {
        static FAKE_CENTER: RefCell<Option<Retained<NSUserNotificationCenter>>> =
            const { RefCell::new(None) };
    }

    pub(crate) fn fake_center() -> Option<Retained<NSUserNotificationCenter>> {
        FAKE_CENTER.with(|center| center.borrow().clone())
    }

    /// Routes this thread's notifications to a recording center instead of the system one.
    pub(crate) fn use_fake_center() -> Retained<NSUserNotificationCenter> {
        let fake = FakeCenter::alloc().set_ivars(FakeCenterState::default());
        let fake: Retained<FakeCenter> = unsafe { msg_send![super(fake), init] };
        let center = unsafe { Retained::cast_unchecked::<NSUserNotificationCenter>(fake) };
        FAKE_CENTER.with(|current| *current.borrow_mut() = Some(center.clone()));
        center
    }

    pub(crate) fn delivered_identifiers(center: &NSUserNotificationCenter) -> Vec<String> {
        center
            .deliveredNotifications()
            .iter()
            .filter_map(|notification| notification.identifier())
            .map(|identifier| identifier.to_string())
            .collect()
    }

    pub(crate) fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        mock_builder().build(mock_context(noop_assets())).unwrap()
    }

    fn target(task_id: &str) -> NotificationTarget {
        serde_json::from_value(json!({ "taskId": task_id, "surface": "chat", "agent": "codex" }))
            .unwrap()
    }

    #[test]
    fn identifiers_match_only_their_own_tasks() {
        let ids = vec!["task-1".to_string(), "task-2".to_string()];
        assert!(notifies_task(&task_identifier("task-1"), &ids));
        assert!(notifies_task(&task_identifier("task-2"), &ids));
        assert!(!notifies_task(&task_identifier("task-10"), &ids));
        assert!(!notifies_task("task-1", &ids));
        assert!(!notifies_task("6F9619FF-8B86-D011-B42D-00C04FC964FF", &ids));
    }

    #[test]
    fn each_task_keeps_one_notification_until_dismissed() {
        let center = use_fake_center();
        let app = mock_app();
        deliver(app.handle(), "Done".into(), "WOR-1".into(), target("t1"));
        deliver(app.handle(), "Waiting".into(), "WOR-1".into(), target("t1"));
        deliver(app.handle(), "Done".into(), "WOR-2".into(), target("t2"));
        assert_eq!(
            delivered_identifiers(&center),
            [task_identifier("t1"), task_identifier("t2")]
        );
        let titles: Vec<String> = center
            .deliveredNotifications()
            .iter()
            .filter_map(|notification| notification.title())
            .map(|title| title.to_string())
            .collect();
        assert_eq!(titles, ["Waiting", "Done"]);

        dismiss(app.handle(), vec!["t1".into(), "unknown".into()]);
        assert_eq!(delivered_identifiers(&center), [task_identifier("t2")]);
    }

    fn inbox_target(task_id: &str, entry: &str) -> NotificationTarget {
        let mut target = target(task_id);
        target.inbox_entry = Some(entry.into());
        target
    }

    #[test]
    fn each_inbox_entry_keeps_its_own_notification_beside_its_tasks() {
        let center = use_fake_center();
        let app = mock_app();
        deliver(app.handle(), "Done".into(), "WOR-1".into(), target("t1"));
        for (task_id, entry) in [
            ("", "approval:a"),
            ("", "permission:b"),
            ("t1", "approval:c"),
        ] {
            deliver(
                app.handle(),
                "demo".into(),
                entry.into(),
                inbox_target(task_id, entry),
            );
        }
        assert_eq!(
            delivered_identifiers(&center),
            [
                task_identifier("t1"),
                "wtm-automation-inbox:approval:a".into(),
                "wtm-automation-inbox:permission:b".into(),
                "wtm-automation-inbox:approval:c".into(),
            ]
        );
    }

    #[test]
    fn clicking_a_notification_opens_its_target_and_removes_it() {
        let center = use_fake_center();
        let app = mock_app();
        let opened = Arc::new(Mutex::new(Vec::new()));
        let seen = opened.clone();
        app.listen_any(NOTIFICATION_OPEN_EVENT, move |event| {
            seen.lock().unwrap().push(event.payload().to_string());
        });
        let mut inbox_target = target("t1");
        inbox_target.inbox_entry = Some("run:demo:r1".into());
        deliver(app.handle(), "Done".into(), "WOR-1".into(), inbox_target);
        let delegate: Retained<AnyObject> = unsafe { msg_send![&*center, delegate] };
        let delivered = center.deliveredNotifications().objectAtIndex(0);
        let foreign = NSUserNotification::new();

        let present: bool = unsafe {
            msg_send![&*delegate, userNotificationCenter: &*center, shouldPresentNotification: &*delivered]
        };
        for notification in [&delivered, &foreign] {
            let _: () = unsafe {
                msg_send![&*delegate, userNotificationCenter: &*center, didActivateNotification: &**notification]
            };
        }

        assert!(present);
        assert!(delivered_identifiers(&center).is_empty());
        let opened = opened.lock().unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&opened[0]).unwrap(),
            json!({
                "taskId": "t1",
                "surface": "chat",
                "agent": "codex",
                "inboxEntry": "run:demo:r1",
            })
        );
    }

    #[test]
    fn without_a_notification_center_nothing_is_delivered() {
        FAKE_CENTER.with(|current| *current.borrow_mut() = None);
        let app = mock_app();
        deliver(app.handle(), "Done".into(), "WOR-1".into(), target("t1"));
        dismiss(app.handle(), vec!["t1".into()]);
    }
}
