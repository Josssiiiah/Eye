import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Camera, Download, Check, Trash } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useEffect, useCallback, useRef, FormEvent, useState } from "react";
import { cn } from "../lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { useChat, Message } from "@ai-sdk/react";
import {
  getScreenshotableMonitors,
  getMonitorScreenshot,
} from "tauri-plugin-screenshots-api";
import {
  checkScreenRecordingPermission,
  requestScreenRecordingPermission,
} from "tauri-plugin-macos-permissions-api";
import { readFile, BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { desktopDir } from "@tauri-apps/api/path";

export default function PopupWindow() {
  // Initialize useChat - only for state management (messages, input, setInput, setMessages)
  const { messages, input, setInput, setMessages } = useChat({
    // Keep this minimal as we manage streaming via Tauri events
  });

  const [isInputFocused, setIsInputFocused] = useState(false);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null); // Ref for scrolling
  const [isProcessing, setIsProcessing] = useState(false); // Local loading state
  const [capturing, setCapturing] = useState(false); // State for screenshot capture
  const [fetchError, setFetchError] = useState<string | null>(null); // Local error state
  const [assistantMessageId, setAssistantMessageId] = useState<string | null>(
    null
  ); // Track current assistant message ID
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(
    null
  ); // For preview
  const [lastScreenshotPath, setLastScreenshotPath] = useState<string | null>(
    null
  ); // Path to saved screenshot
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  // Show toast notification
  const showToast = (
    message: string,
    type: "success" | "error" = "success"
  ) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Parse messages to properly render images
  const renderMessageContent = (content: string) => {
    // Check if the content contains an image markdown
    const imageRegex = /!\[Screenshot\]\((data:image\/[^)]+)\)/;
    const match = content.match(imageRegex);

    if (match && match[1]) {
      // Extract the base64 image URL
      const imageUrl = match[1];
      // Replace the markdown with an actual image element
      const textWithoutImage = content.replace(imageRegex, "").trim();

      return (
        <>
          {textWithoutImage && <p className="mb-2">{textWithoutImage}</p>}
          <div className="relative group">
            <img
              src={imageUrl}
              alt="Screenshot"
              className="max-w-full rounded-md border border-border/30 mt-2"
              style={{ maxHeight: "300px" }}
            />
          </div>
        </>
      );
    }

    // Just return the text if no image
    return content;
  };

  // Custom handler to initiate streaming via Tauri command
  const handleSendMessage = async () => {
    if (!input.trim() && !screenshotPreview) return;
    if (isProcessing) return;

    try {
      // Validate screenshot if present
      if (screenshotPreview) {
        if (
          !screenshotPreview.startsWith("data:image/") ||
          !screenshotPreview.includes("base64,")
        ) {
          throw new Error("Invalid image format in preview");
        }

        const [_, base64Data] = screenshotPreview.split("base64,");
        if (!base64Data || base64Data.trim().length === 0) {
          throw new Error("Screenshot contains no image data");
        }
      }

      // Combine text input with screenshot if there's a preview
      const combinedInput = screenshotPreview
        ? `${
            input.trim() ? input + "\n" : ""
          }![Screenshot](${screenshotPreview})`
        : input;

      const newUserMessage: Message = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: combinedInput,
      };

      // Add user message and a placeholder for assistant response
      const placeholderId = crypto.randomUUID();
      const placeholderAssistantMessage: Message = {
        id: placeholderId,
        role: "assistant" as const,
        content: "", // Start with empty content
      };

      setMessages([...messages, newUserMessage, placeholderAssistantMessage]);
      setAssistantMessageId(placeholderId); // Track the ID of the message we'll update
      setInput("");
      setScreenshotPreview(null); // Clear the preview after sending
      setIsProcessing(true);
      setFetchError(null);

      // Prepare history *excluding* the placeholder assistant message
      const historyForBackend = [...messages, newUserMessage].map(
        ({ id, ...rest }) => rest
      );

      try {
        // Invoke the Rust command which will start emitting events
        // It now returns () on success or throws an error if setup fails
        await invoke("chat_mastra", {
          prompt: combinedInput,
          messagesHistory: historyForBackend,
        });
        // Don't update messages here directly, wait for events
        if (promptInputRef.current) {
          promptInputRef.current.focus();
        }
      } catch (err: any) {
        console.error("Failed to initiate chat stream:", err);
        let errorMessage = "Failed to start chat.";
        if (typeof err === "string") {
          errorMessage = err;
        } else if (err instanceof Error) {
          errorMessage = err.message;
        }
        setFetchError(errorMessage);
        // Remove placeholder on initial invoke error
        setMessages((currentMessages) => currentMessages.slice(0, -1));
        setIsProcessing(false);
        setAssistantMessageId(null);
      }
    } catch (err) {
      console.error("Message validation error:", err);
      let errorMessage = err instanceof Error ? err.message : String(err);
      showToast(errorMessage, "error");
      setFetchError(errorMessage);
    }
    // Note: setIsProcessing(false) will be handled by stream end/error events
  };

  // Function to save screenshot to desktop
  const saveScreenshotToDesktop = async () => {
    if (!screenshotPreview) return null;

    try {
      // Validate screenshot preview format
      if (
        !screenshotPreview.startsWith("data:image/") ||
        !screenshotPreview.includes("base64,")
      ) {
        throw new Error("Invalid image format");
      }

      // Extract MIME type and base64 data
      const [mimeHeader, base64Data] = screenshotPreview.split("base64,");
      if (!base64Data || base64Data.trim().length === 0) {
        throw new Error("Empty image data");
      }

      // Get file extension from MIME type
      const mimeType = mimeHeader.split(":")[1].split(";")[0];
      const fileExtension = mimeType === "image/png" ? "png" : "jpg";

      // Convert base64 to Uint8Array safely
      try {
        const binaryString = window.atob(base64Data);
        if (binaryString.length === 0) {
          throw new Error("Decoded binary data is empty");
        }

        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        if (bytes.length === 0) {
          throw new Error("Byte array is empty");
        }

        // Get desktop directory path
        const desktopPath = await desktopDir();
        const timestamp = new Date()
          .toISOString()
          .replace(/:/g, "-")
          .replace(/\..+/, "");
        const fileName = `zen-screenshot-${timestamp}.${fileExtension}`;
        const filePath = `${desktopPath}${fileName}`;

        // Write file to disk
        await writeFile(filePath, bytes);

        // Verify file was written successfully
        try {
          const fileCheck = await readFile(filePath);
          if (!fileCheck || fileCheck.length === 0) {
            throw new Error("File was written but appears to be empty");
          }
        } catch (error) {
          console.error("Error verifying file:", error);
          throw new Error(
            "Failed to verify screenshot file was saved correctly"
          );
        }

        setLastScreenshotPath(filePath);

        // Show toast notification
        showToast(`Screenshot saved to desktop`);
        console.log(`Screenshot saved to ${filePath}`);

        // Return the path for potential use
        return filePath;
      } catch (error) {
        console.error("Binary data conversion error:", error);
        throw new Error("Failed to process image data");
      }
    } catch (error) {
      console.error("Failed to save screenshot:", error);
      showToast("Failed to save screenshot to desktop", "error");
      setFetchError(
        `Failed to save screenshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  };

  // Handler for screenshot capture
  const handleCaptureScreenshot = async () => {
    try {
      setCapturing(true);
      // 1. Permission dance for macOS
      const hasPerm = await checkScreenRecordingPermission();
      if (!hasPerm) {
        const granted = await requestScreenRecordingPermission();
        if (!granted) {
          showToast("Screen recording permission denied", "error");
          setFetchError("Screen recording permission denied");
          return;
        }
        // User must re-click after granting; exit early
        setCapturing(false);
        return;
      }

      // 2. Choose the primary monitor (index 0)
      const monitors = await getScreenshotableMonitors();
      if (monitors.length === 0) {
        throw new Error("No monitor detected");
      }
      const pngPath = await getMonitorScreenshot(monitors[0].id);

      // 3. Read the file as binary using the plugin-fs API
      const imgBinary = await readFile(pngPath);

      // Validate the imgBinary is not empty
      if (!imgBinary || imgBinary.length === 0) {
        throw new Error("Screenshot resulted in empty image data");
      }

      // 4. Create an image element to resize it
      const resizeImage = (imgBuffer: Uint8Array): Promise<string | null> => {
        return new Promise((resolve) => {
          try {
            const blob = new Blob([imgBuffer], { type: "image/png" });
            if (blob.size === 0) {
              console.error("Empty image blob created");
              resolve(null);
              return;
            }

            const url = URL.createObjectURL(blob);
            const img = new Image();

            // Handle image loading errors
            img.onerror = () => {
              console.error("Failed to load image");
              URL.revokeObjectURL(url);
              resolve(null);
            };

            img.onload = () => {
              try {
                // Create canvas for resizing
                const canvas = document.createElement("canvas");
                canvas.width = 512;
                canvas.height = 512;

                // Draw image with proper scaling
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                  console.error("Failed to get canvas context");
                  URL.revokeObjectURL(url);
                  resolve(null);
                  return;
                }

                ctx.drawImage(img, 0, 0, 512, 512);

                // Get base64 from canvas
                const base64 = canvas.toDataURL("image/jpeg", 0.9);
                URL.revokeObjectURL(url);

                // Validate base64 string
                if (
                  !base64 ||
                  base64 === "data:," ||
                  !base64.includes("base64")
                ) {
                  console.error("Invalid base64 image generated");
                  resolve(null);
                  return;
                }

                resolve(base64);
              } catch (err) {
                console.error("Error processing image in canvas:", err);
                URL.revokeObjectURL(url);
                resolve(null);
              }
            };

            img.src = url;
          } catch (err) {
            console.error("Error creating blob from image buffer:", err);
            resolve(null);
          }
        });
      };

      // 5. Resize the image and get base64
      const base64Image = await resizeImage(imgBinary);

      if (!base64Image) {
        throw new Error("Failed to process screenshot");
      }

      // 6. Store the preview directly instead of adding to the input right away
      setScreenshotPreview(base64Image);

      // 7. Save a copy of the screenshot automatically
      await saveScreenshotToDesktop();

      if (promptInputRef.current) {
        promptInputRef.current.focus();
      }
    } catch (err) {
      console.error("Screenshot error:", err);
      showToast(String(err), "error");
      setFetchError(String(err));
    } finally {
      setCapturing(false);
    }
  };

  // Open the saved screenshot
  const openSavedScreenshot = async () => {
    if (lastScreenshotPath) {
      try {
        await openPath(lastScreenshotPath);
      } catch (err) {
        console.error("Failed to open screenshot:", err);
        showToast("Failed to open saved screenshot", "error");
        setFetchError("Failed to open saved screenshot");
      }
    }
  };

  // Function to clear the conversation
  const clearConversation = () => {
    setMessages([]);
    setScreenshotPreview(null);
    setFetchError(null);
    showToast("Conversation cleared");
  };

  // Effect to set up event listeners
  useEffect(() => {
    let unlistenChunk: (() => void) | undefined;
    let unlistenEnd: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    const setupListeners = async () => {
      unlistenChunk = await listen<string>("chat_chunk", (event) => {
        console.log("Chunk received:", event.payload);
        setMessages((currentMessages) =>
          currentMessages.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: msg.content + event.payload }
              : msg
          )
        );
      });

      unlistenEnd = await listen<void>("chat_stream_end", () => {
        console.log("Stream ended");
        setIsProcessing(false);
        setAssistantMessageId(null); // Reset tracker
        if (promptInputRef.current) {
          promptInputRef.current.focus();
        }
      });

      unlistenError = await listen<string>("chat_stream_error", (event) => {
        console.error("Stream error:", event.payload);
        setFetchError(event.payload);
        // Update the placeholder message with the error
        setMessages((currentMessages) =>
          currentMessages.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: `Error: ${event.payload}` }
              : msg
          )
        );
        setIsProcessing(false);
        setAssistantMessageId(null); // Reset tracker
      });
    };

    setupListeners();

    // Cleanup function
    return () => {
      unlistenChunk?.();
      unlistenEnd?.();
      unlistenError?.();
    };
  }, [assistantMessageId]); // Re-run if assistantMessageId changes (though it shouldn't mid-stream)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !isProcessing &&
      (input.trim() || screenshotPreview)
    ) {
      e.preventDefault(); // Prevent potential form submission/newline
      handleSendMessage();
    }
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !isProcessing &&
      (input.trim() || screenshotPreview)
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
  }, [messages, screenshotPreview]);

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
              <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                <Button
                  onClick={clearConversation}
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-full transition-colors duration-300"
                  title="Clear conversation"
                >
                  <Trash className="h-4 w-4" />
                  <span className="sr-only">Clear conversation</span>
                </Button>
                <Button
                  onClick={() =>
                    invoke("close_popup_window").catch(console.error)
                  }
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-full transition-colors duration-300"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </Button>
              </div>
            </div>
          </div>

          {/* Chat Area & Input */}
          <div className="flex flex-col flex-grow px-4 pt-2 pb-6">
            {/* Messages Area */}
            <div className="flex-grow space-y-3 overflow-y-auto pr-2 min-h-0">
              {messages.length === 0 &&
                !isProcessing &&
                !fetchError &&
                !screenshotPreview && (
                  <div className="flex flex-col items-center justify-center h-full text-center space-y-2 text-muted-foreground/70">
                    <p className="text-sm font-medium">Ask me anything!</p>
                    <p className="text-xs">
                      Your conversation will appear here.
                    </p>
                  </div>
                )}

              {messages.map((m) => (
                <motion.div
                  key={m.id}
                  layout // Add layout animation for smoother updates
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className={cn(
                    "p-4 rounded-xl shadow-md border border-border/30 text-sm",
                    m.role === "user"
                      ? "bg-primary/10 text-primary-foreground place-self-end ml-10"
                      : "bg-background/80 place-self-start mr-10",
                    // Add a style for the potentially empty streaming message
                    m.role === "assistant" &&
                      m.content === "" &&
                      isProcessing &&
                      "min-h-[20px]" // Give it min height while streaming empty
                  )}
                >
                  {/* Render content with proper image handling */}
                  {m.role === "assistant" &&
                  m.id === assistantMessageId &&
                  isProcessing &&
                  m.content === "" ? (
                    <span className="animate-pulse">▋</span>
                  ) : (
                    renderMessageContent(m.content)
                  )}
                </motion.div>
              ))}

              {/* Error display */}
              <AnimatePresence>
                {fetchError && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="text-sm text-red-400 font-medium rounded-md bg-red-500/10 border border-red-500/20 px-4 py-3 mt-4"
                  >
                    {/* Display general fetch error if not handled by stream error */}
                    Error: {fetchError}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Screenshot Preview */}
            {screenshotPreview && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4 rounded-xl overflow-hidden relative group"
              >
                <div className="w-full relative pb-2">
                  <img
                    src={screenshotPreview}
                    alt="Screenshot preview"
                    className="max-w-full h-auto max-h-[300px] object-contain rounded-xl border border-border/30 mx-auto"
                  />
                  <div className="absolute top-2 right-2 opacity-80 group-hover:opacity-100 transition-opacity flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 rounded-full bg-black/70 hover:bg-primary transition-colors"
                      onClick={() => setScreenshotPreview(null)}
                    >
                      <X className="h-3 w-3 mr-1" />
                      <span className="text-xs">Remove</span>
                    </Button>
                    {lastScreenshotPath && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 rounded-full bg-black/70 hover:bg-primary transition-colors"
                        onClick={openSavedScreenshot}
                      >
                        <Download className="h-3 w-3 mr-1" />
                        <span className="text-xs">Open</span>
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-center mt-1 text-muted-foreground">
                    Screenshot captured and saved to desktop
                  </p>
                </div>
              </motion.div>
            )}

            {/* Toast Notification */}
            <AnimatePresence>
              {toast && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className={cn(
                    "fixed top-4 right-4 px-4 py-2 rounded-lg shadow-lg z-50 flex items-center gap-2",
                    toast.type === "success"
                      ? "bg-green-500/20 text-green-500 border border-green-500/30"
                      : "bg-red-500/20 text-red-500 border border-red-500/30"
                  )}
                >
                  {toast.type === "success" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  <span className="text-sm font-medium">{toast.message}</span>
                </motion.div>
              )}
            </AnimatePresence>

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
                  placeholder={
                    screenshotPreview
                      ? "Add message to screenshot..."
                      : "Ask anything..."
                  }
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
                {/* Screenshot Button */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={capturing || isProcessing}
                  onClick={handleCaptureScreenshot}
                  className="h-8 w-8 rounded-full px-0 bg-black/70 hover:bg-primary transition-colors shrink-0 flex items-center justify-center"
                >
                  {capturing ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                  ) : (
                    <Camera className="h-4 w-4" />
                  )}
                  <span className="sr-only">Take Screenshot</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleSendMessage}
                  disabled={
                    isProcessing || (!input.trim() && !screenshotPreview)
                  } // Enable if either input or screenshot
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
