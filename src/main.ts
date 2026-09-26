import { mount } from "./ui/app";
import "./style.css";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app");
mount(root);
