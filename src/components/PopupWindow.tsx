import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useEffect, useCallback, useRef, FormEvent, useState } from "react";
import { cn } from "../lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { useChat, Message } from "@ai-sdk/react";

export default function PopupWindow() {
  // Initialize useChat - only for state management (messages, input, setInput, setMessages)
  const { messages, input, setInput, setMessages } = useChat({
    // Remove api and fetch options
    // We now manage messages and loading state manually
  });

  const [isInputFocused, setIsInputFocused] = useState(false);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null); // Ref for scrolling
  const [isProcessing, setIsProcessing] = useState(false); // Local loading state
  const [fetchError, setFetchError] = useState<string | null>(null); // Local error state

  // Custom handler to call Tauri command and update messages via setMessages
  const handleSendMessage = async () => {
    if (!input.trim() || isProcessing) return; // Prevent sending while processing

    const currentInput = input;
    const newUserMessage: Message = {
      id: crypto.randomUUID(), // Generate an ID for the user message
      role: "user" as const,
      content: currentInput,
    };

    // Update messages optimistically with user message
    setMessages([...messages, newUserMessage]);
    setInput(""); // Clear input field
    setIsProcessing(true); // Set local loading state
    setFetchError(null); // Clear previous errors

    // Prepare history for the backend call *excluding* the ID
    // Include the *new* user message in the history sent to backend
    const historyForBackend = [...messages, newUserMessage].map(
      ({ id, ...rest }) => rest
    );

    try {
      const result = await invoke<string>("chat", {
        prompt: currentInput,
        messagesHistory: historyForBackend, // Send history including the new user msg
      });

      const assistantMessage: Message = {
        id: crypto.randomUUID(), // Generate an ID for the assistant message
        role: "assistant" as const,
        content: result,
      };

      // Update messages with assistant response
      setMessages((currentMessages) => [...currentMessages, assistantMessage]);

      if (promptInputRef.current) {
        promptInputRef.current.focus();
      }
    } catch (err: any) {
      console.error("Failed to call chat command:", err);
      let errorMessage = "An unknown error occurred.";
      if (typeof err === "string") {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }
      setFetchError(errorMessage); // Set local error state
      // Remove the failed user message for simplicity, or add a system error message
      setMessages((currentMessages) => currentMessages.slice(0, -1));
    } finally {
      setIsProcessing(false); // Reset local loading state
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !isProcessing &&
      input.trim()
    ) {
      e.preventDefault(); // Prevent potential form submission/newline
      handleSendMessage();
    }
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !isProcessing &&
      input.trim()
    ) {
      e.preventDefault(); // Prevent potential form submission/newline
      handleSendMessage();
    }
  };

  useEffect(() => {
    if (promptInputRef.current) {
      promptInputRef.current.focus();
    }
  }, []);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="fixed inset-0 bg-background/65 rounded-xl backdrop-blur-sm flex h-full">
      {/* Outer container for scrolling */}
      <div
        ref={scrollAreaRef}
        className="w-full h-full overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* Inner container to ensure content pushes height */}
        <div className="flex flex-col min-h-full">
          {/* Drag Region & Header */}
          <div
            data-tauri-drag-region
            className="sticky top-0 z-10 bg-background/65 backdrop-blur-sm"
          >
            <div
              data-tauri-drag-region
              className="absolute top-0 left-0 right-0 h-8"
              style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            />
            <div
              data-tauri-drag-region
              className="flex items-center justify-between px-6 pt-5 pb-3"
              style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            >
              <h1
                data-tauri-drag-region
                className="text-lg font-medium tracking-tight"
                style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
              >
                Zen Chat
              </h1>
              <Button
                onClick={() =>
                  invoke("close_popup_window").catch(console.error)
                }
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-full transition-colors duration-300"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </div>

          {/* Chat Area & Input */}
          <div className="flex flex-col flex-grow px-4 pt-2 pb-6">
            {/* Messages Area */}
            <div className="flex-grow space-y-3 overflow-y-auto pr-2 min-h-0">
              {messages.length === 0 && !isProcessing && !fetchError && (
                <div className="flex flex-col items-center justify-center h-full text-center space-y-2 text-muted-foreground/70">
                  <p className="text-sm font-medium">Ask me anything!</p>
                  <p className="text-xs">Your conversation will appear here.</p>
                </div>
              )}

              {messages.map((m) => (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className={cn(
                    "p-4 rounded-xl shadow-md border border-border/30 whitespace-pre-wrap text-sm",
                    m.role === "user"
                      ? "bg-primary/10 text-primary-foreground place-self-end ml-10"
                      : "bg-background/80 place-self-start mr-10"
                  )}
                >
                  {m.content}
                </motion.div>
              ))}

              {/* Use local isProcessing state for the loading indicator */}
              {isProcessing && (
                <div className="flex justify-start items-center py-2 pl-4">
                  <div className="relative h-5 w-5">
                    <div className="absolute inset-0 rounded-full border-t-2 border-l-2 border-accent animate-spin"></div>
                  </div>
                </div>
              )}

              {/* Use local fetchError state for displaying errors */}
              <AnimatePresence>
                {fetchError && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="text-sm text-red-400 font-medium rounded-md bg-red-500/10 border border-red-500/20 px-4 py-3 mt-4"
                  >
                    Error: {fetchError}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Input Area */}
            <motion.div
              initial={false}
              className={cn(
                "mt-4 space-y-2 rounded-xl pt-3 pb-3",
                isInputFocused && "bg-accent/30 ring-1 ring-accent/20",
                "transition-all duration-300"
              )}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <div className={cn("flex px-4 items-center space-x-2")}>
                <Input
                  ref={promptInputRef}
                  placeholder="Ask anything..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => setIsInputFocused(false)}
                  onKeyDown={handleKeyDown}
                  disabled={isProcessing} // Disable input based on local state
                  className={cn(
                    "flex-grow border-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-10 placeholder:text-white/90",
                    isInputFocused ? "text-black" : "text-white",
                    "transition-all duration-300"
                  )}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleSendMessage}
                  disabled={isProcessing || !input.trim()} // Disable button based on local state
                  className="h-8 rounded-full px-3 bg-black/70 hover:bg-primary transition-colors shrink-0"
                >
                  {/* Show spinner based on local state */}
                  {isProcessing ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                  ) : (
                    <span className="text-xs">Send</span>
                  )}
                </Button>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}
