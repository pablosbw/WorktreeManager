// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows rarely sets HOME; the app, its CLI and the tools they launch expect it.
    #[cfg(windows)]
    if std::env::var_os("HOME").is_none() {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            std::env::set_var("HOME", profile);
        }
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--cli") {
        attach_terminal();
    }
    if let Some(code) = app_lib::cli::run_if_requested() {
        std::process::exit(code);
    }
    app_lib::run();
}

/// A release build on Windows is a GUI program: it gets no console, and no standard output or
/// error unless the caller redirected them. For the CLI, output already redirected to a file or
/// pipe is kept; whatever is missing is pointed at the console of the terminal that started it.
#[cfg(windows)]
fn attach_terminal() {
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
        STD_OUTPUT_HANDLE,
    };

    let missing = |id| {
        let handle = unsafe { GetStdHandle(id) };
        handle.is_null() || handle == INVALID_HANDLE_VALUE
    };
    let streams: Vec<_> = [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]
        .into_iter()
        .filter(|&id| missing(id))
        .collect();
    if streams.is_empty() || unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
        return;
    }
    let console: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
    for id in streams {
        let handle = unsafe {
            CreateFileW(
                console.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            unsafe { SetStdHandle(id, handle) };
        }
    }
}
