import { createRoot } from "react-dom/client";
import { App } from "./app/App.jsx";
import "./styles.css";
import "./features/context/context.css";

createRoot(document.getElementById("root")).render(<App />);
