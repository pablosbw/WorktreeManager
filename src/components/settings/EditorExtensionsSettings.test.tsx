// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { EditorExtensionsSettings } from "./EditorExtensionsSettings";

const preferences = vi.hoisted(() => ({ loadPreference: vi.fn(), persist: vi.fn() }));
vi.mock("../../services/preferences", async (original) => ({
  ...(await original<typeof import("../../services/preferences")>()),
  ...preferences,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const field = () => screen.getByLabelText("Default extension IDs");
const save = () => screen.getByRole("button", { name: "Save extensions" });

describe("EditorExtensionsSettings", () => {
  it("saves distinct IDs, one per line", async () => {
    preferences.loadPreference.mockResolvedValue(["golang.go"]);
    preferences.persist.mockResolvedValue(undefined);
    render(<EditorExtensionsSettings />);
    await waitFor(() => expect(field()).toHaveValue("golang.go"));
    expect(save()).toBeDisabled();
    fireEvent.change(field(), {
      target: { value: "golang.go\n\n  redhat.vscode-yaml \nGOLANG.GO" },
    });
    fireEvent.click(save());
    await waitFor(() => expect(field()).toHaveValue("golang.go\nredhat.vscode-yaml"));
    expect(preferences.persist).toHaveBeenCalledWith([
      ["editorExtensions", ["golang.go", "redhat.vscode-yaml"]],
    ]);
    expect(save()).toBeDisabled();
  });

  it("names lines that are not extension IDs and saves nothing", async () => {
    preferences.loadPreference.mockResolvedValue([]);
    render(<EditorExtensionsSettings />);
    await waitFor(() => expect(field()).toBeEnabled());
    fireEvent.change(field(), { target: { value: "golang.go\n../extension.vsix\nprettier" } });
    fireEvent.click(save());
    expect(
      await screen.findByText("Not extension IDs (use publisher.name): ../extension.vsix, prettier")
    ).toBeInTheDocument();
    expect(preferences.persist).not.toHaveBeenCalled();
  });

  it("reports load and save failures", async () => {
    preferences.loadPreference.mockRejectedValueOnce(new Error("store unavailable"));
    render(<EditorExtensionsSettings />);
    expect(await screen.findByText("Error: store unavailable")).toBeInTheDocument();
    expect(field()).toBeDisabled();
    cleanup();
    preferences.loadPreference.mockResolvedValue([]);
    preferences.persist.mockRejectedValueOnce(new Error("disk full"));
    render(<EditorExtensionsSettings />);
    await waitFor(() => expect(field()).toBeEnabled());
    fireEvent.change(field(), { target: { value: "golang.go" } });
    fireEvent.click(save());
    expect(await screen.findByText("Error: disk full")).toBeInTheDocument();
    expect(field()).toHaveValue("golang.go");
  });
});
