import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PopupWindow from "./components/PopupWindow";
import DragWindow from "./components/DragWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

const Main = () => {
  const [windowType, setWindowType] = useState<string>("main");

  useEffect(() => {
    const checkWindowType = async () => {
      try {
        const win = getCurrentWindow();
        const label = await win.label;
        if (label === "popup") {
          setWindowType("popup");
        } else if (label === "drag-chat") {
          setWindowType("drag-chat");
        } else {
          setWindowType("main");
        }
      } catch (error) {
        console.error("Failed to get window label:", error);
      }
    };

    checkWindowType();
  }, []);

  // Render the appropriate component based on window type
  switch (windowType) {
    case "popup":
      return <PopupWindow />;
    case "drag-chat":
      return <DragWindow />;
    default:
      return <App />;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Main />
  </React.StrictMode>
);
