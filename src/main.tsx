import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PopupWindow from "./components/PopupWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";


const Main = () => {
  const [isPopup, setIsPopup] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    // Detect if this is the popup window by checking the window label
    setIsPopup(win.label === "popup");

  }, []);

  // Render either PopupWindow or App based on the window label
  return isPopup ? <PopupWindow /> : <App />;
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Main />
  </React.StrictMode>
);
