import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { Button } from "./components/ui/button";

function App() {
  const openPopup = () => {
    invoke("open_popup_window").catch(console.error);
  };

  return (
    <main className="fixed top-0 left-0 right-0 bg-black/20 backdrop-blur-sm h-12 flex items-center justify-end px-4">
      <Button
        onClick={openPopup}
        variant="ghost"
        className="text-white hover:bg-white/20"
      >
        Ask AI
      </Button>
    </main>
  );
}

export default App;
