import type { App } from "@modelcontextprotocol/ext-apps";

export async function openManagerNote(app: App, path: string) {
  const result = await app.callServerTool({ name: "learning_manager_open_note", arguments: { path } });
  if (result.isError) throw new Error("未能打开 Obsidian，请确认已安装并接入此知识库。");
}
