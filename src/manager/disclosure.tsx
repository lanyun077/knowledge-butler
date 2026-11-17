import { useRef, useState, type ReactNode } from "react";

export function Disclosure({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  const element = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  return <details ref={element} className={`disclosure ${className}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>
    {open && <div className="disclosure-content">{children}<button className="text-button" onClick={() => {
      element.current!.open = false; setOpen(false);
      element.current!.querySelector("summary")!.focus();
      element.current!.scrollIntoView?.({ block: "nearest" });
    }}>收起</button></div>}
  </details>;
}
