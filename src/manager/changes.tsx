import { Disclosure } from "./disclosure";

export function ChangePreview({ before, after }: { before: string; after: string }) {
  let start = 0, end = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (end < Math.min(before.length, after.length) - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const previous = before.slice(Math.max(0, start - 120), Math.min(before.length, before.length - end + 120));
  const next = after.slice(Math.max(0, start - 120), Math.min(after.length, after.length - end + 120));
  return <div className="change-preview">
    <p className="meta">本次变更：移除 {before.length - start - end} 字符，写入 {after.length - start - end} 字符</p>
    <h2>修改前摘录</h2><pre>{previous.slice(0, 400) || "（无）"}{previous.length > 400 && "…"}</pre>
    <h2>修改后摘录</h2><pre>{next.slice(0, 400) || "（无）"}{next.length > 400 && "…"}</pre>
    <Disclosure title="查看完整变更与上下文">
      <h2>修改前</h2><pre>{before || "（新建文件）"}</pre><h2>修改后</h2><pre>{after || "（删除正文）"}</pre>
    </Disclosure>
  </div>;
}
