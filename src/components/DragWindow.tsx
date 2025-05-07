import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Camera, Download, Check, Trash } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useEffect, useCallback, useRef, FormEvent, useState } from "react";
import { cn } from "../lib/utils";
import { useChat, Message } from "@ai-sdk/react";
import { v4 as uuidv4 } from "uuid";
import { readFile, BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { desktopDir } from "@tauri-apps/api/path";

// Define the expected structure from the Rust backend
interface UploadResult {
  key: string;
  url: string;
}

export default function DragWindow() {
  // Initialize useChat - only for state management (messages, input, setInput, setMessages)
  const { messages, input, setInput, setMessages, append } = useChat({
    // Keep this minimal as we manage streaming via Tauri events
  });

  // Gate refs to prevent duplicate operations
  const tauriListenersRef = useRef<{
    offChunk?: () => void;
    offEnd?: () => void;
    offErr?: () => void;
  } | null>(null);

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
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null); // Pre-signed URL
  const [isUploading, setIsUploading] = useState(false); // Upload specific loading state
  const [lastScreenshotPath, setLastScreenshotPath] = useState<string | null>(
    null
  ); // Path to saved screenshot on desktop
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  // Auto-capture region when window appears
  useEffect(() => {
    // Removed auto-capture on mount
    // captureRegionAndProcess();
  }, []);

  // Consolidate event listeners (mount-only)
  useEffect(() => {
    let isMounted = true; // helps guard against async race

    (async () => {
      /* ----------- guard against Strict-Mode double run ----------- */
      if (tauriListenersRef.current) return; // already registered

      const offChunk = await listen<string>("chat_chunk", ({ payload }) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantIdRef.current
              ? { ...m, content: m.content + payload }
              : m
          )
        );
      });

      const offEnd = await listen("chat_stream_end", () => {
        assistantIdRef.current = null;
        setIsProcessing(false);
        if (promptInputRef.current) {
          promptInputRef.current.focus();
        }
      });

      const offErr = await listen<string>("chat_stream_error", (e) => {
        setFetchError(e.payload);
        // Update the placeholder message with the error
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantIdRef.current
              ? { ...m, content: `Error: ${e.payload}` }
              : m
          )
        );
        setIsProcessing(false);
        assistantIdRef.current = null;
      });

      if (isMounted) {
        tauriListenersRef.current = { offChunk, offEnd, offErr };
      } else {
        /* component unmounted before async finished */
        offChunk();
        offEnd();
        offErr();
      }
    })();

    return () => {
      isMounted = false;
      if (tauriListenersRef.current) {
        tauriListenersRef.current.offChunk?.();
        tauriListenersRef.current.offEnd?.();
        tauriListenersRef.current.offErr?.();
        tauriListenersRef.current = null; // clear for next mount
      }
    };
  }, []); // ← stays empty

  // Show toast notification
  const showToast = (
    message: string,
    type: "success" | "error" = "success"
  ) => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Modify the renderMessageContent function to better handle images within messages
  const renderMessageContent = (content: string) => {
    // Check for image directly embedded in the content (new format)
    const directImageRegex = /\!\[Screenshot\]\(([^)]+)\)/;
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
            style={{ maxHeight: "300px", objectFit: "contain" }}
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
              style={{ maxHeight: "300px", objectFit: "contain" }}
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
    return <div className="whitespace-pre-wrap">{content}</div>;
  };

  // Send message handler
  const handleSendMessage = async () => {
    // Check if there's text input OR a screenshot key available
    if (!input.trim() && !lastUploadedR2Key) return;
    if (isProcessing) return;

    // Use the pre-signed URL from state if available
    if (!input.trim() && !presignedUrl) {
      console.log("Send aborted: No text input and no pre-signed URL.");
      return;
    }

    setIsProcessing(true);
    setFetchError(null);

    let signedImageUrl: string | null = presignedUrl;
    let userPromptContent = input.trim();
    let keyToClear: string | null = lastUploadedR2Key;
    let urlToClear: string | null = presignedUrl;
    let imagePreviewToEmbed: string | null = screenshotPreview;

    try {
      // 1. Prepare message for local display
      const newUserMessage: Message = {
        id: crypto.randomUUID(),
        role: "user" as const,
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

      // Clear input state
      setInput("");

      // 2. Prepare history for backend
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
        imageUrl: signedImageUrl, // Pass the pre-signed URL
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

  // Function to save screenshot to desktop (using path)
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
      const destinationPath = `${desktopPath}/${fileName}`;

      // Read the original file
      const bytes = await readFile(screenshotPath); // Read original path

      if (!bytes || bytes.length === 0) {
        throw new Error(
          "Original screenshot file is empty or could not be read"
        );
      }

      // Write file to disk
      await writeFile(destinationPath, bytes);

      setLastScreenshotPath(destinationPath); // Store path to the saved file

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

  // Capture the region underneath the window
  const captureRegionAndProcess = async () => {
    // Prevent capturing if already uploading or processing a message
    if (isUploading || isProcessing) return;

    setCapturing(true);
    setIsUploading(true);
    setScreenshotPreview(null);
    setScreenshotPath(null);
    setLastUploadedR2Key(null);
    setPresignedUrl(null);
    setFetchError(null);

    try {
      // Capture the region and upload directly using the Rust command
      const uploadResult = await invoke<UploadResult>(
        "capture_region_and_upload"
      );

      console.log("Region captured and uploaded:", uploadResult);

      setLastUploadedR2Key(uploadResult.key);
      setPresignedUrl(uploadResult.url);

      // Generate a local preview from the presigned URL
      setScreenshotPreview(uploadResult.url);

      // Save a local copy
      await saveScreenshotToDesktop();

      showToast("Region captured successfully");

      // Focus input for additional questions or to send the image
      if (promptInputRef.current) {
        promptInputRef.current.focus();
      }

      return uploadResult;
    } catch (err) {
      console.error("Error during region capture:", err);
      showToast(
        `Capture failed: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
      setFetchError(String(err));

      // Clear potentially inconsistent state on error
      setScreenshotPreview(null);
      setScreenshotPath(null);
      setLastUploadedR2Key(null);
      setPresignedUrl(null);

      return null;
    } finally {
      setCapturing(false);
      setIsUploading(false);
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
    setLastUploadedR2Key(null);
    setPresignedUrl(null);
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
      (input.trim() || lastUploadedR2Key) &&
      (input.trim() || presignedUrl)
    ) {
      e.preventDefault();
      handleSendMessage();
    }
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !isProcessing &&
      (input.trim() || lastUploadedR2Key) &&
      (input.trim() || presignedUrl)
    ) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Focus input on mount
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
    <div className="fixed inset-0 bg-background/5 rounded-xl backdrop-blur-sm flex h-full">
      {/* Outer container for scrolling - NOW A MOTION.DIV */}
      <div
        ref={scrollAreaRef}
        className="w-full h-full overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* Inner container to ensure content pushes height */}
        <div className="flex flex-col min-h-full">
          {/* Drag Region & Header */}
          <div
            data-tauri-drag-region
            className="sticky top-0 z-10 "
          >
            <div
              data-tauri-drag-region
              className="flex items-center justify-between px-4 py-2"
            >
              <div className="flex items-center space-x-2">
                <span className="text-xs text-white">Drag or Resize</span>
              </div>
              <div className="flex items-center gap-1"></div>
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
                    {/* Empty state content */}
                  </div>
                )}

              {/* Add standalone screenshot preview when available but no messages yet */}
              {messages.length === 0 && screenshotPreview && !isProcessing && (
                <div className="flex flex-col items-center justify-center mt-4 p-3">
                  <div className="mb-2 text-sm text-center text-muted-foreground">
                    Screenshot captured:
                  </div>
                  <div className="relative rounded-md overflow-hidden border border-border/30 shadow-md">
                    <img
                      src={screenshotPreview}
                      alt="Screenshot Preview"
                      className="max-w-full rounded-md"
                      style={{ maxHeight: "300px", objectFit: "contain" }}
                    />
                    {/* Optional loading overlay while processing starts */}
                    {isUploading && (
                      <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
                        <div className="px-3 py-1 bg-background/80 rounded-md text-xs">
                          Processing...
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Messages container - changed to grid layout */}
              <div className="grid grid-cols-1 gap-3 w-full">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "p-3 rounded-xl shadow-md border border-border/30 text-sm max-w-[85%] w-fit",
                      m.role === "user"
                        ? "bg-primary/10 text-primary-foreground justify-self-end"
                        : "bg-background/80 justify-self-start",
                      // Add a style for the potentially empty streaming message
                      m.role === "assistant" &&
                        m.content === "" &&
                        isProcessing &&
                        "min-h-[40px] min-w-[40px]" // Give it min height/width while streaming empty
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
                  </div>
                ))}
              </div>

              {/* Error display */}
              {fetchError && (
                <div className="text-sm text-red-400 font-medium rounded-md bg-red-500/10 border border-red-500/20 px-4 py-3 mt-4">
                  Error: {fetchError}
                </div>
              )}

              {/* Display uploading indicator */}
              {isUploading && (
                <div className="text-xs text-center text-muted-foreground italic mt-2">
                  Uploading region capture...
                </div>
              )}
            </div>

            {/* Input Area */}
            <div className="mt-4 relative">
              <Input
                ref={promptInputRef}
                type="text"
                placeholder={
                  isProcessing
                    ? "Waiting for response..."
                    : "Type your message..."
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isProcessing}
                className={cn(
                  "pr-20 py-6 bg-background/30 border-border/30 placeholder-white",
                  isInputFocused ? "ring-2 ring-primary/20" : ""
                )}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => setIsInputFocused(false)}
              />
              <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-1">
                <Button
                  onClick={handleSendMessage}
                  disabled={isProcessing || (!input.trim() && !presignedUrl)}
                  size="sm"
                  className="h-8 text-white"
                >
                  Send
                </Button>
              </div>
            </div>
            {/* Moved Buttons Area */}
            <div className="mt-3 flex items-center justify-between px-1">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={captureRegionAndProcess}
                  disabled={isProcessing || isUploading}
                  title="Capture Region"
                >
                  <Camera className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={clearConversation}
                  title="Clear Conversation"
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => invoke("close_drag_window").catch(console.error)}
                title="Close Window"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div
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
        </div>
      )}
    </div>
  );
}
