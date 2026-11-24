import { FormEvent, useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { EXTENSION_ID, extensionIds, loadPreference, persist } from "../../services/preferences";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function EditorExtensionsSettings() {
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPreference("editorExtensions").then(
      (ids) => {
        setSaved(ids.join("\n"));
        setDraft(ids.join("\n"));
      },
      (reason) => setError(String(reason))
    );
  }, []);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void save();
  }

  async function save() {
    if (draft === null) return;
    const invalid = lines(draft).filter((line) => !EXTENSION_ID.test(line));
    if (invalid.length) {
      setError(`Not extension IDs (use publisher.name): ${invalid.join(", ")}`);
      return;
    }
    const ids = extensionIds(lines(draft));
    setBusy(true);
    setError(null);
    try {
      await persist([["editorExtensions", ids]]);
      setSaved(ids.join("\n"));
      setDraft(ids.join("\n"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby="vscode-extensions"
      className="px-6 pt-3 pb-6 space-y-3"
    >
      <h4 id="vscode-extensions" className="text-xs font-semibold text-text-secondary">
        Extensions
      </h4>
      <p className="text-xs text-text-muted">
        Installed into the embedded VS Code for every workspace, from the Open VSX marketplace,
        before a workspace&apos;s editor starts. Extensions you add inside the editor stay
        installed, and removing an ID here does not uninstall it.
      </p>
      <textarea
        aria-label="Default extension IDs"
        placeholder={
          "One ID per line, e.g.\nshd101wyy.markdown-preview-enhanced\nesbenp.prettier-vscode"
        }
        value={draft ?? ""}
        rows={6}
        spellCheck={false}
        disabled={draft === null || busy}
        onChange={(event) => setDraft(event.target.value)}
        className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent"
      />
      {error && <p className="text-xs text-danger select-text">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={draft === null || busy || draft.trim() === saved}>
          Save extensions
        </Button>
        <p className="text-xs text-text-muted">
          New IDs install the next time a workspace&apos;s editor starts.
        </p>
      </div>
    </form>
  );
}
