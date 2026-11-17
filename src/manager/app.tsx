import { App } from "@modelcontextprotocol/ext-apps";
import { createRoot } from "react-dom/client";
import { Manager } from "./view";
import css from "./styles.css";

const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
const app = new App({ name: "知识管家", version: "u2-v4" }, {});
createRoot(document.getElementById("root")!).render(<Manager app={app} />);
