export interface NoteReference { path: string; version: string; scope: string }

export function referenceHash(reference: NoteReference): string {
  return `#learning-os/overview?${new URLSearchParams({ note: reference.path, version: reference.version, scope: reference.scope })}`;
}

export function referenceFromHash(hash: string): NoteReference | undefined {
  const parameters = new URLSearchParams(hash.split("?")[1]);
  const path = parameters.get("note");
  const version = parameters.get("version");
  const scope = parameters.get("scope");
  if (!path || !version || !scope) return undefined;
  return { path, version, scope };
}
