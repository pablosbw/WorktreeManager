import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loadPreference } from "./preferences";
import { EditorPresentationController, editorOpen, type EditorPresentation } from "./codeEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./preferences", () => ({ loadPreference: vi.fn() }));

const bounds = { x: 40, y: 80, width: 800, height: 600 };

describe("opening the editor", () => {
  it("sends the default extensions, or none when they cannot be read", async () => {
    vi.mocked(loadPreference).mockResolvedValueOnce(["golang.go"]);
    await editorOpen("a", "workspace", ["/a"]);
    expect(invoke).toHaveBeenLastCalledWith("vscode_open", {
      taskId: "a",
      workspaceId: "workspace",
      folders: ["/a"],
      extensions: ["golang.go"],
    });
    vi.mocked(loadPreference).mockRejectedValueOnce(new Error("store unavailable"));
    await editorOpen("a", "workspace", ["/a"]);
    expect(invoke).toHaveBeenLastCalledWith(
      "vscode_open",
      expect.objectContaining({ extensions: [] })
    );
  });
});

describe("editor presentation", () => {
  it("ignores late cleanup and resizing from a previous task", () => {
    const dispatch = vi
      .fn<(state: EditorPresentation) => Promise<void>>()
      .mockResolvedValue(undefined);
    const controller = new EditorPresentationController(dispatch);
    const first = controller.attach("a", "editor", bounds, vi.fn());
    controller.attach("b", "editor", bounds, vi.fn());
    first.release();
    first.update({ ...bounds, width: 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
      taskId: "b",
      bounds,
      suppressed: false,
    });
    expect(dispatch.mock.calls[1][0].revision).toBeGreaterThan(dispatch.mock.calls[0][0].revision);
  });

  it("keeps the editor hidden until every modal has closed, including task switches", () => {
    const dispatch = vi
      .fn<(state: EditorPresentation) => Promise<void>>()
      .mockResolvedValue(undefined);
    const controller = new EditorPresentationController(dispatch);
    controller.attach("a", "editor", bounds, vi.fn());
    const closeFirst = controller.suppress();
    const closeSecond = controller.suppress();
    controller.attach("b", "editor", bounds, vi.fn());
    closeFirst();
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
      taskId: "b",
      suppressed: true,
      focus: false,
    });
    closeSecond();
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
      taskId: "b",
      suppressed: false,
      focus: true,
    });
  });

  it("presents the surface the task pane selected", () => {
    const dispatch = vi
      .fn<(state: EditorPresentation) => Promise<void>>()
      .mockResolvedValue(undefined);
    const controller = new EditorPresentationController(dispatch);
    controller.attach("a", "opencode", bounds, vi.fn());
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ taskId: "a", surface: "opencode" });
    controller.attach("a", "editor", bounds, vi.fn());
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ taskId: "a", surface: "editor" });
    controller.reset();
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ taskId: null, surface: null });
  });

  it("returning to the list only clears presentation", () => {
    const dispatch = vi
      .fn<(state: EditorPresentation) => Promise<void>>()
      .mockResolvedValue(undefined);
    const controller = new EditorPresentationController(dispatch);
    controller.attach("a", "editor", bounds, vi.fn()).release();
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ taskId: null });
    controller.attach("a", "editor", bounds, vi.fn());
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ taskId: "a" });
    controller.reset();
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ taskId: null });
  });
});
