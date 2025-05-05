import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Camera, Download, Check, Trash, UploadCloud } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useEffect, useCallback, useRef, FormEvent, useState } from "react";
import { cn } from "../lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { useChat, Message } from "@ai-sdk/react";
import { v4 as uuidv4 } from "uuid";
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

// Define the expected structure from the Rust backend
interface UploadResult {
  key: string;
  url: string;
}

export default function PopupWindow() {
  // Initialize useChat - only for state management (messages, input, setInput, setMessages)
  const { messages, input, setInput, setMessages, append } = useChat({
    // Keep this minimal as we manage streaming via Tauri events
  });

  const [isInputFocused, setIsInputFocused] = useState(false);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null); // Ref for scrolling
  const [isProcessing, setIsProcessing] = useState(false); // Local loading state
  const [capturing, setCapturing] = useState(false); // State for screenshot capture
  const [fetchError, setFetchError] = useState<string | null>(null); // Local error state
  // Replace assistantMessageId state with a ref to avoid closure issues
  const assistantIdRef = useRef<string | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(
    null
  ); // For preview (base64)
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null); // Path to original screenshot file
  const [lastUploadedR2Key, setLastUploadedR2Key] = useState<string | null>(
    null
  ); // Key of last successful upload
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null); // *** Add state for pre-signed URL ***
  const [isUploading, setIsUploading] = useState(false); // Upload specific loading state
  const [lastScreenshotPath, setLastScreenshotPath] = useState<string | null>(
    null
  ); // Path to saved screenshot on desktop
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  // Auto-capture screenshot when popup opens
  useEffect(() => {
    // fire-and-forget; internal state flags prevent double execution
    handleCaptureScreenshot(true); // Pass true to indicate background capture
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ← run exactly once when popup loads

  // Consolidate listeners (mount-only)
  useEffect(() => {
    const setupListeners = async () => {
      const offChunk = await listen<string>("chat_chunk", (event) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantIdRef.current
              ? { ...m, content: m.content + event.payload }
              : m
          )
        );
      });

      const offEnd = await listen<void>("chat_stream_end", () => {
        console.log("Stream ended");
        setIsProcessing(false);
        assistantIdRef.current = null; // Reset tracker
        if (promptInputRef.current) {
          promptInputRef.current.focus();
        }
      });

      const offError = await listen<string>("chat_stream_error", (event) => {
        console.error("Stream error:", event.payload);
        setFetchError(event.payload);
        // Update the placeholder message with the error
        setMessages((currentMessages) =>
          currentMessages.map((msg) =>
            msg.id === assistantIdRef.current
              ? { ...msg, content: `Error: ${event.payload}` }
              : msg
          )
        );
        setIsProcessing(false);
        assistantIdRef.current = null; // Reset tracker
      });

      return () => {
        offChunk();
        offEnd();
        offError();
      };
    };

    setupListeners();
  }, []); // ← empty deps for mount-only effect

  // Show toast notification
  const showToast = (
    message: string,
    type: "success" | "error" = "success"
  ) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Helper to start greeting chat with just an image URL
  const startGreetingChat = async (imageUrl: string) => {
    // 0. defensive guard
    if (!imageUrl) return;
    if (isProcessing) return;

    setIsProcessing(true);
    setFetchError(null);

    try {
      // 1. make a blank assistant placeholder *first*
      const assistantId = crypto.randomUUID();
      assistantIdRef.current = assistantId;
      append({
        id: assistantId,
        role: "assistant",
        content: "",
      });

      // 2. call backend (empty prompt, only image)
      await invoke("chat_mastra", {
        prompt: "",
        messagesHistory: [], // fresh conversation
        imageUrl,
      });
    } catch (err: any) {
      console.error("Error during greeting chat:", err);
      let errorMessage = "Failed to start greeting chat.";
      if (typeof err === "string") {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }
      setFetchError(errorMessage);
      showToast(errorMessage, "error");
      setIsProcessing(false);
      assistantIdRef.current = null;
    }
  };

  // Modify the renderMessageContent function to better handle images within messages
  const renderMessageContent = (content: string) => {
    // Check for image directly embedded in the content (new format)
    const directImageRegex = /\!\[Screenshot\]\((data:image\/[^)]+)\)/;
    const directMatch = content.match(directImageRegex);

    if (directMatch && directMatch[1]) {
      const imageUrl = directMatch[1];
      const textWithoutImage = content.replace(directImageRegex, "").trim();
      return (
        <>
          {textWithoutImage && <p className="mb-2">{textWithoutImage}</p>}
          <img
            src={imageUrl}
            alt="Screenshot"
            className="max-w-full rounded-md border border-border/30 mt-2"
            style={{ maxHeight: "300px" }}
          />
        </>
      );
    }

    // Legacy support for "local_preview" placeholder - only works when screenshotPreview is available
    if (
      content.includes("![Screenshot Preview](local_preview)") &&
      screenshotPreview
    ) {
      const textWithoutPlaceholder = content
        .replace("![Screenshot Preview](local_preview)", "")
        .trim();
      return (
        <>
          {textWithoutPlaceholder && (
            <p className="mb-2">{textWithoutPlaceholder}</p>
          )}
          <div className="relative group">
            <img
              src={screenshotPreview}
              alt="Screenshot Preview"
              className="max-w-full rounded-md border border-border/30 mt-2"
              style={{ maxHeight: "300px" }}
            />
            <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-md">
              <span className="text-white text-xs font-bold bg-black/50 px-2 py-1 rounded">
                PREVIEW
              </span>
            </div>
          </div>
        </>
      );
    }

    // Just return text if no image
    return content;
  };

  // Modify handleSendMessage function to clear the screenshot preview after sending
  const handleSendMessage = async () => {
    // Check if there's text input OR a screenshot key available
    if (!input.trim() && !lastUploadedR2Key) return;
    if (isProcessing) return;

    // Use the pre-signed URL from state if available
    if (!input.trim() && !presignedUrl) {
      console.log("Send aborted: No text input and no pre-signed URL.");
      return;
    }

    setIsProcessing(true); // Still use isProcessing for the overall send operation
    setFetchError(null);

    let signedImageUrl: string | null = presignedUrl; // *** Use pre-signed URL from state ***
    let userPromptContent = input.trim();
    let keyToClear: string | null = lastUploadedR2Key; // Store key to clear later
    let urlToClear: string | null = presignedUrl; // Store URL to clear later
    let imagePreviewToEmbed: string | null = screenshotPreview; // Store the current preview

    try {
      // 1. Prepare message for local display
      const newUserMessage: Message = {
        id: crypto.randomUUID(),
        role: "user" as const,
        // CHANGE: If we have a screenshot, embed it directly as image data
        content: imagePreviewToEmbed
          ? `${
              userPromptContent ? userPromptContent + "\n" : ""
            }![Screenshot](${imagePreviewToEmbed})`
          : userPromptContent,
      };

      // Add user message & placeholder assistant message
      const placeholderId = crypto.randomUUID();
      assistantIdRef.current = placeholderId;
      const placeholderAssistantMessage: Message = {
        id: placeholderId,
        role: "assistant" as const,
        content: "",
      };
      setMessages([...messages, newUserMessage, placeholderAssistantMessage]);

      // Clear input state *now*
      setInput("");

      // 2. Prepare history for backend (strip preview placeholder)
      const historyForBackend = [...messages]
        .filter(
          (msg) =>
            msg && typeof msg === "object" && "role" in msg && "content" in msg
        )
        .map(({ role, content }) => ({
          role: role,
          content:
            typeof content === "string"
              ? content
                  .replace(/\!\[Screenshot\]\(data:image\/[^)]+\)/, "")
                  .trim()
              : "",
        }));

      // 3. Invoke the Rust command with the pre-signed URL from state
      console.log("Invoking chat_mastra with prompt and URL:", signedImageUrl);
      await invoke("chat_mastra", {
        prompt: userPromptContent,
        messagesHistory: historyForBackend,
        imageUrl: signedImageUrl, // Pass the pre-signed URL from state (or null)
      });

      // 4. Clear preview state AFTER successful invocation
      if (keyToClear) {
        setLastUploadedR2Key(null);
        console.log("Cleared last uploaded R2 key:", keyToClear);
      }
      if (urlToClear) {
        setPresignedUrl(null);
        console.log("Cleared pre-signed URL.");
        // Clear the standalone preview but the image data is already in the message content
        setScreenshotPreview(null);
        setScreenshotPath(null);
      }

      // Focus input after successful invocation start
      if (promptInputRef.current) {
        promptInputRef.current.focus();
      }
    } catch (err: any) {
      console.error("Error during send message flow:", err);
      let errorMessage = "Failed to send message.";
      if (typeof err === "string") {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }
      setFetchError(errorMessage);
      showToast(errorMessage, "error");
      setMessages((currentMessages) => currentMessages.slice(0, -2));
      setIsProcessing(false);
      assistantIdRef.current = null;
    }
    // Note: setIsProcessing(false) is handled by stream end/error events
  };

  // Function to save ORIGINAL screenshot to desktop (using path)
  const saveScreenshotToDesktop = async () => {
    if (!screenshotPath) return null; // Check path now

    try {
      // Get desktop directory path
      const desktopPath = await desktopDir();
      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\.\.+/, "");
      // Use original file extension if possible, default to png
      const fileExtension = screenshotPath.split(".").pop() || "png";
      const fileName = `zen-screenshot-${timestamp}.${fileExtension}`;
      const destinationPath = `${desktopPath}${fileName}`;

      // Read the original file
      const bytes = await readFile(screenshotPath); // Read original path

      if (!bytes || bytes.length === 0) {
        throw new Error(
          "Original screenshot file is empty or could not be read"
        );
      }

      // Write file to disk
      await writeFile(destinationPath, bytes);

      // Verify file was written (optional but good practice)
      // ... (verification logic can be added here if needed)

      setLastScreenshotPath(destinationPath); // Store path to the *saved* file

      showToast(`Screenshot saved to desktop`);
      console.log(`Screenshot saved to ${destinationPath}`);

      return destinationPath;
    } catch (error) {
      console.error("Failed to save original screenshot:", error);
      showToast("Failed to save screenshot to desktop", "error");
      setFetchError(
        `Failed to save screenshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  };

  // Handler for screenshot capture - NOW includes upload
  const handleCaptureScreenshot = async (isBackgroundCapture = false) => {
    // Prevent capturing if already uploading or processing a message
    if (isUploading || isProcessing) return;

    setCapturing(true);
    setIsUploading(true); // Indicate upload process starting

    // Only clear preview if this isn't a background capture
    if (!isBackgroundCapture) {
      setScreenshotPreview(null);
    }

    setScreenshotPath(null);
    setLastUploadedR2Key(null); // Clear previous key
    setPresignedUrl(null); // *** Clear previous pre-signed URL ***
    setFetchError(null);

    let originalPngPath: string | null = null;

    try {
      // 1. Permission Check (same as before)
      const hasPerm = await checkScreenRecordingPermission();
      if (!hasPerm) {
        const granted = await requestScreenRecordingPermission();
        if (!granted) {
          showToast("Screen recording permission denied", "error");
          setFetchError("Screen recording permission denied");
          setCapturing(false);
          setIsUploading(false); // Ensure upload state is reset on permission denial
          return;
        }
        // User must re-click after granting; exit early
        setCapturing(false);
        setIsUploading(false); // Ensure upload state is reset on permission denial
        return;
      }

      // 2. Capture Screenshot (same as before)
      const monitors = await getScreenshotableMonitors();
      if (monitors.length === 0) throw new Error("No monitor detected");
      originalPngPath = await getMonitorScreenshot(monitors[0].id);
      setScreenshotPath(originalPngPath); // Store path
      console.log("Screenshot captured:", originalPngPath);

      // 3. Generate Preview (only if not a background capture)
      let base64Preview: string | null = null;
      if (!isBackgroundCapture) {
        const imgBinary = await readFile(originalPngPath);
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
        base64Preview = await resizeImage(imgBinary);
        if (!base64Preview)
          throw new Error("Failed to process screenshot preview");
        setScreenshotPreview(base64Preview);
        console.log("Preview generated.");
      }

      // 4. **Upload Immediately and get key + pre-signed URL**
      console.log(`Uploading ${originalPngPath} immediately...`);
      // *** Update invoke call to expect UploadResult ***
      const uploadResult = await invoke<UploadResult>("upload_image_to_r2", {
        filePath: originalPngPath,
      });
      setLastUploadedR2Key(uploadResult.key);
      setPresignedUrl(uploadResult.url); // *** Store the pre-signed URL ***
      console.log("Uploaded to R2, key:", uploadResult.key);
      console.log("Received pre-signed URL:", uploadResult.url);

      // Only show toast for manual captures
      if (!isBackgroundCapture) {
        showToast(`Screenshot captured and uploaded!`); // Update toast message
      }

      // 5. Save Local Copy (same as before)
      await saveScreenshotToDesktop();

      // 6. Automatically start greeting chat with the uploaded image
      await startGreetingChat(uploadResult.url);

      // Focus input
      if (promptInputRef.current) {
        promptInputRef.current.focus();
      }
    } catch (err) {
      console.error("Error during capture/upload:", err);

      // Only show toast for manual captures or serious background errors
      if (!isBackgroundCapture || String(err).includes("permission")) {
        showToast(
          `Capture/Upload failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "error"
        );
      }

      setFetchError(String(err));
      // Clear potentially inconsistent state on error
      setScreenshotPreview(null);
      setScreenshotPath(null);
      setLastUploadedR2Key(null);
      setPresignedUrl(null); // *** Clear pre-signed URL on error ***
      if (originalPngPath) {
        // Try to clean up temp screenshot file if path exists
        // Note: Tauri FS plugin doesn't have a delete yet, this is a placeholder
        console.warn(
          "Need to implement cleanup for temp screenshot:",
          originalPngPath
        );
      }
    } finally {
      setCapturing(false);
      setIsUploading(false); // Ensure upload state is reset
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
    setScreenshotPath(null);
    setLastUploadedR2Key(null); // Clear R2 key too
    setPresignedUrl(null); // *** Clear pre-signed URL too ***
    setFetchError(null);
    showToast("Conversation cleared");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !isProcessing &&
      (input.trim() || lastUploadedR2Key) && // Check key
      (input.trim() || presignedUrl) // *** Also check pre-signed URL for sending ***
    ) {
      e.preventDefault();
      handleSendMessage();
    }
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !isProcessing &&
      (input.trim() || lastUploadedR2Key) && // Check key
      (input.trim() || presignedUrl) // *** Also check pre-signed URL for sending ***
    ) {
      e.preventDefault();
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
              <div
                className="flex items-center gap-2"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
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
                  m.id === assistantIdRef.current &&
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

              {/* Display uploading indicator? Maybe near preview or input */}
              {isUploading && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-xs text-center text-muted-foreground italic mt-2"
                >
                  Uploading screenshot...
                </motion.div>
              )}
            </div>

            {/* Screenshot Preview */}
            {screenshotPreview && !isProcessing && (
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
                      onClick={() => {
                        setScreenshotPreview(null);
                        setScreenshotPath(null);
                        setLastUploadedR2Key(null); // *** Clear R2 key on manual removal ***
                        setPresignedUrl(null); // *** Clear pre-signed URL on manual removal ***
                      }}
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
                    {/* Update text based on whether key exists */}
                    {lastUploadedR2Key
                      ? "Screenshot uploaded."
                      : "Screenshot captured."}
                    {lastScreenshotPath ? " Saved locally." : ""}
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
                  disabled={isProcessing || isUploading} // Disable input during upload too
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
                  disabled={capturing || isUploading || isProcessing} // Disable during capture, upload, or send
                  onClick={() => handleCaptureScreenshot(false)}
                  className="h-8 w-8 rounded-full px-0 bg-black/70 hover:bg-primary transition-colors shrink-0 flex items-center justify-center"
                >
                  {/* Show different spinner/icon based on state */}
                  {capturing ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                  ) : isUploading ? (
                    <UploadCloud className="h-4 w-4 animate-pulse text-blue-400" /> // Upload icon
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
                    isProcessing ||
                    isUploading || // Disable during upload
                    (!input.trim() && !presignedUrl) // *** Disable if no text AND no pre-signed URL ***
                  }
                  className="h-8 rounded-full px-3 bg-black/70 hover:bg-primary transition-colors shrink-0"
                >
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
