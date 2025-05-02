import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { Button } from "./components/ui/button";

function App() {
  const openPopup = () => {
    invoke("open_popup_window").catch(console.error);
  };

  return (
    <main className="container mx-auto px-4 py-12 max-w-3xl">
      <h1 className="text-2xl font-bold mb-4">Welcome to Tauri + React</h1>
      <p className="text-muted-foreground mb-6">
        Click the button below to open a transparent, rounded popup window.
      </p>

      <Button onClick={openPopup} className="bg-primary hover:bg-primary/90">
        Open Transparent Popup
      </Button>
    </main>
  );
}

export default App;
