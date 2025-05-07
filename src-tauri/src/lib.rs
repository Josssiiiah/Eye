use tauri::{AppHandle, Manager, Result, Runtime, WebviewUrl, Window, Emitter};
use tauri_plugin_sql::{Migration, MigrationKind};
use std::env;
// Removed unused vibrancy imports as they're commented out in the code
use serde::{Deserialize, Serialize};
use reqwest;
use tokio_stream::StreamExt;
use std::path::Path;
use uuid::Uuid;
use std::time::Duration; // Import Duration for presigning

// Core Graphics imports for screen capture
use core_graphics;
use core_foundation;
use foreign_types_shared::ForeignType;   // Add the ForeignType trait

// AWS / R2 Imports
use aws_config::meta::region::RegionProviderChain;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::presigning::PresigningConfig; // Import PresigningConfig
use anyhow::{anyhow, Context}; // Import anyhow and Context

#[macro_use]
extern crate objc; // brings msg_send!, sel! and sel_impl!

#[cfg(target_os = "macos")]
use {
    objc::runtime::Object,         // For macOS NSWindow access
    cocoa::foundation::NSRect,
};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Define a struct for the image URL content part
#[derive(Serialize, Deserialize, Debug, Clone)]
struct ImageUrlContent {
    #[serde(rename = "type")]
    type_field: String,
    image: String,
}

// Define a struct for the text content part
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TextContent {
    #[serde(rename = "type")]
    type_field: String,
    text: String,
}

// Define a union enum for different content types if needed, or use serde_json::Value
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
enum ContentPart {
    Text(TextContent),
    ImageUrl(ImageUrlContent),
}

// Update ChatMessage to use ContentPart for flexibility
#[derive(Serialize, Deserialize, Debug, Clone)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<String>,
}

// Define a struct to deserialize the streaming chunk from Mastra
// Assuming it sends JSON objects with a 'text' field per chunk
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct MastraStreamChunk {
    text: Option<String>,
    // Add other fields if Mastra sends more, like 'finishReason'
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

#[tauri::command]
async fn open_popup_window<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    // Check if the window already exists
    if let Some(window) = app.get_webview_window("popup") {
        // If it exists, bring it to the front
        window.set_focus()?;
    } else {
        // If it doesn't exist, create it
        let builder = tauri::WebviewWindowBuilder::new(&app, "popup", WebviewUrl::App("popup.html".into()))
            .title("Popup Window")
            .inner_size(400.0, 300.0)
            .position(100.0, 100.0)
            .transparent(true) 
            .decorations(false) // No window decorations (title bar, etc.)
            .resizable(true)
            .skip_taskbar(true)
            .focused(true)
            .always_on_top(true); // Ensure popup stays on top

        // Create the window (prefix with underscore to indicate intentional unused variable)
        let _window = builder.build()?;
        
        // Vibrancy effects are disabled as they're for transparent windows
    }
    Ok(())
}

#[tauri::command]
async fn close_popup_window<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    if let Some(window) = app.get_webview_window("popup") {
        window.close()?;
    }
    Ok(())
}

#[tauri::command]
async fn chat(prompt: String, messages_history: Vec<ChatMessage>) -> std::result::Result<String, String> {
    use openai_rust::{Client, chat::ChatArguments};
    // Role and Message are already used below, no need to import again here

    dotenvy::dotenv().map_err(|e| format!("Failed to load .env file: {}", e))?;
    let key = env::var("OPENAI_API_KEY").map_err(|e| format!("Failed to get OPENAI_API_KEY: {}", e))?;
    let client = Client::new(&key);

    // Map the incoming Vec<ChatMessage> to Vec<openai_rust::chat::Message>
    let mut history: Vec<openai_rust::chat::Message> = messages_history
        .into_iter()
        .map(|msg| openai_rust::chat::Message {
            role: msg.role,
            content: msg.content,
        })
        .collect();

    // Add the new user prompt to the history
    history.push(openai_rust::chat::Message {
        role: "user".to_string(),
        content: prompt, // Use the separate prompt variable
    });

    // Use the full history in the arguments
    let args = ChatArguments::new(
        "gpt-4o",
        history // Pass the combined history
    );

    // Use tokio runtime for the async call
    // map_err ensures the error type matches the function's String error type
    let result = tokio::task::spawn(async move {
        client.create_chat(args).await
    }).await.map_err(|e| format!("Task join error: {}", e))?; // Handle potential join error

    // The rest of the match statement is now correct because the error types align
    match result {
        Ok(res) => {
            // Check if choices are available and get the first one
            if let Some(choice) = res.choices.get(0) {
                // Access content directly assuming it's String, not Option<String>
                // Check if message and content exist (though content error suggests it's not Option)
                // A simple access like choice.message.content.clone() might work if message is guaranteed
                // Let's keep it simpler for now based on the error.
                 Ok(choice.message.content.clone()) // Directly clone the content String
            } else {
                Err("OpenAI response did not contain any choices.".to_string())
            }
        }
        Err(e) => Err(format!("OpenAI API error: {}", e)),
    }
}

// --- MODIFIED COMMAND ---
#[tauri::command]
async fn chat_mastra<R: Runtime>(
    prompt: String,
    messages_history: Vec<ChatMessage>,
    image_url: Option<String>,
    app: AppHandle<R>,
) -> std::result::Result<(), String> {
    let mastra_endpoint = "http://localhost:4111/api/agents/weatherAgent/stream";
    // Create a client with optimized timeout and pool settings
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))  // Set a reasonable timeout 
        .pool_max_idle_per_host(10)        // Keep connections alive for reuse
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    // Start constructing the messages payload for Mastra
    let mut final_messages_payload: Vec<serde_json::Value> = Vec::new();

    // Process history messages (assuming simple text content for now)
    for msg in messages_history {
        final_messages_payload.push(serde_json::json!({
            "role": msg.role,
            "content": [{ "type": "text", "text": msg.content }]
        }));
    }

    // Construct the current user message payload
    let mut current_user_content: Vec<ContentPart> = Vec::new();

    // Add text part if prompt is not empty
    if !prompt.trim().is_empty() {
        current_user_content.push(ContentPart::Text(TextContent {
            type_field: "text".to_string(),
            text: prompt.trim().to_string(),
        }));
    }

    // Add image URL part if provided (now expects a pre-signed URL)
    if let Some(url) = image_url {
         println!("Image URL received in chat_mastra: {}", url); // Debugging
        // Basic validation for URL format might still be useful, but R2 presigned URLs are complex
        if url.starts_with("https://") {
            current_user_content.push(ContentPart::ImageUrl(ImageUrlContent {
                type_field: "image".to_string(),
                image: url,
            }));
        } else {
            eprintln!("Warning: Provided image_url does not look like a secure pre-signed URL: {}", url);
            // Decide if you want to proceed or error out if the URL is not HTTPS
        }
    }

    // Add the fully constructed user message to the payload
    if !current_user_content.is_empty() {
        final_messages_payload.push(serde_json::json!({
            "role": "user",
            "content": current_user_content
        }));
    } else {
        // Allow sending empty text prompt if an image URL *is* provided
        if final_messages_payload.iter().any(|m| m["role"] == "user" && m["content"].as_array().map_or(false, |c| c.iter().any(|p| p["type"] == "image_url"))) {
             println!("Sending message with only image.");
        } else {
             return Err("Cannot send an empty message without an image.".to_string());
        }
    }

    // Prepare request body according to Mastra stream API
    let request_body = serde_json::json!({
        "messages": final_messages_payload,
    });

    println!("Sending request to Mastra stream API. Payload:");
    println!("{}", serde_json::to_string_pretty(&request_body).unwrap_or_default());

    // Try to get either the popup window or the drag-chat window
    let window = app.get_webview_window("popup")
        .or_else(|| app.get_webview_window("drag-chat"))
        .ok_or_else(|| "Neither popup nor drag-chat window found".to_string())?;

    // Execute the request and process the stream
    let res = client.post(mastra_endpoint)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to send request to Mastra server: {}", e))?;

    let status = res.status();
    println!("Received response from Mastra. Status: {}", status);

    if !status.is_success() {
        let error_text = res.text().await.unwrap_or_else(|_| "Failed to read error body".to_string());
        let error_msg = format!("Mastra server returned error ({}): {}", status, error_text);
        // Emit error event before returning Err
        window.emit("chat_stream_error", &error_msg).map_err(|e| format!("Failed to emit error event: {}", e))?;
        return Err(error_msg);
    }

    // Process the stream - use the stream method available in reqwest with tokio_stream
    let mut stream = res.bytes_stream();
    let mut buffer = String::with_capacity(1024); // Pre-allocate a decent buffer size

    // Create a debouncer to coalesce small updates and reduce UI renders
    let mut last_emit = std::time::Instant::now();
    let mut accumulated_text = String::with_capacity(512);  

    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk_bytes) => {
                // Convert the bytes to a string
                let chunk_str = String::from_utf8_lossy(&chunk_bytes).to_string();
                
                // Append to our buffer
                buffer.push_str(&chunk_str);

                // Process any complete lines
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    // More efficient substring extraction
                    buffer.drain(..=pos);

                    // Skip empty lines
                    if line.is_empty() {
                        continue;
                    }

                    // Parse the Mastra streaming format with different prefixes
                    if line.len() >= 2 && line.chars().nth(1) == Some(':') {
                        let prefix = line.chars().next().unwrap_or('?');
                        let content = &line[2..];

                        match prefix {
                            'f' => {
                                // First message, typically contains messageId
                                println!("Message start: {}", content);
                            },
                            '0' => {
                                // Text content chunk - use efficient string handling
                                if let Ok(content_json) = serde_json::from_str::<serde_json::Value>(content) {
                                    if let Some(text) = content_json.as_str() {
                                        // Accumulate text and only emit after a reasonable batch or time
                                        accumulated_text.push_str(text);
                                        
                                        // Emit if we have enough text or enough time has passed
                                        let now = std::time::Instant::now();
                                        if accumulated_text.len() > 50 || now.duration_since(last_emit).as_millis() > 100 {
                                            window.emit("chat_chunk", &accumulated_text)
                                                .map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                            accumulated_text.clear();
                                            last_emit = now;
                                        }
                                    }
                                } else if content.starts_with('"') && content.ends_with('"') && content.len() >= 2 {
                                    // Handle quoted content
                                    let clean_content = &content[1..content.len()-1];
                                    accumulated_text.push_str(clean_content);
                                    
                                    // Same emit logic as above
                                    let now = std::time::Instant::now();
                                    if accumulated_text.len() > 50 || now.duration_since(last_emit).as_millis() > 100 {
                                        window.emit("chat_chunk", &accumulated_text)
                                            .map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                        accumulated_text.clear();
                                        last_emit = now;
                                    }
                                }
                            },
                            'e' | 'd' => {
                                // End message or Done message
                                println!("Stream end marker: {} - {}", prefix, content);
                                
                                // Emit any remaining accumulated text
                                if !accumulated_text.is_empty() {
                                    window.emit("chat_chunk", &accumulated_text)
                                        .map_err(|e| format!("Failed to emit final chat chunk: {}", e))?;
                                    accumulated_text.clear();
                                }
                            },
                            '3' => {
                                // Error message
                                println!("Error message: {}", content);
                                // Strip quotes if present in error message
                                let error_content = if content.starts_with('"') && content.ends_with('"') && content.len() >= 2 {
                                    &content[1..content.len()-1]
                                } else {
                                    content
                                };
                                window.emit("chat_stream_error", error_content)
                                    .map_err(|e| format!("Failed to emit error: {}", e))?;
                            },
                            _ => {
                                // Unknown prefix, try to extract useful content
                                println!("Unknown prefix: {} - content: {}", prefix, content);
                            }
                        }
                    } else if line.starts_with("data: ") {
                        // Handle standard SSE format as fallback
                        let data = &line[6..]; // Skip "data: " prefix

                        if data == "[DONE]" {
                            println!("Stream complete marker received");
                            // Emit any remaining text
                            if !accumulated_text.is_empty() {
                                window.emit("chat_chunk", &accumulated_text)
                                    .map_err(|e| format!("Failed to emit final SSE chat chunk: {}", e))?;
                                accumulated_text.clear();
                            }
                            continue;
                        }

                        // Try to parse data content
                        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(text) = json_value.get("text").and_then(|t| t.as_str()) {
                                accumulated_text.push_str(text);
                                
                                // Same emit logic
                                let now = std::time::Instant::now();
                                if accumulated_text.len() > 50 || now.duration_since(last_emit).as_millis() > 100 {
                                    window.emit("chat_chunk", &accumulated_text)
                                        .map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                    accumulated_text.clear();
                                    last_emit = now;
                                }
                            }
                        } else if !data.is_empty() {
                            accumulated_text.push_str(data);
                            
                            // Same emit logic
                            let now = std::time::Instant::now();
                            if accumulated_text.len() > 50 || now.duration_since(last_emit).as_millis() > 100 {
                                window.emit("chat_chunk", &accumulated_text)
                                    .map_err(|e| format!("Failed to emit raw SSE chunk: {}", e))?;
                                accumulated_text.clear();
                                last_emit = now;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                // Error reading from the stream
                let stream_error_msg = format!("Error reading stream from Mastra: {}", e);
                eprintln!("{}", stream_error_msg);
                window.emit("chat_stream_error", &stream_error_msg)
                    .map_err(|e| format!("Failed to emit stream error event: {}", e))?;
                // Terminate processing on stream error
                return Err(stream_error_msg);
            }
        }
    }

    // Emit any remaining text before signaling the end
    if !accumulated_text.is_empty() {
        window.emit("chat_chunk", &accumulated_text)
            .map_err(|e| format!("Failed to emit final chat chunk: {}", e))?;
    }

    // Signal the end of the stream
    println!("Emitting stream end"); // Debugging
    window.emit("chat_stream_end", ()).map_err(|e| format!("Failed to emit stream end event: {}", e))?;
    Ok(()) // Return Ok(()) as the stream finished successfully
}
// --- /MODIFIED COMMAND ---

// Define the structure for the return value
#[derive(Serialize)]
struct UploadResult {
    key: String,
    url: String,
}

// --- R2 Upload Command ---
#[tauri::command]
// Modify the return type to use the UploadResult struct
async fn upload_image_to_r2(file_path: String) -> tauri::Result<UploadResult> {
    println!("Attempting to upload image from path: {}", file_path);

    // Load R2 configuration from environment variables, map errors to anyhow::Error
    let account_id = env::var("R2_ACCOUNT_ID")
        .map_err(|e| anyhow!("R2_ACCOUNT_ID not set: {}", e))?;
    let access_key_id = env::var("R2_ACCESS_KEY_ID")
        .map_err(|e| anyhow!("R2_ACCESS_KEY_ID not set: {}", e))?;
    let secret_access_key = env::var("R2_SECRET_ACCESS_KEY")
        .map_err(|e| anyhow!("R2_SECRET_ACCESS_KEY not set: {}", e))?;
    let bucket_name = env::var("R2_BUCKET_NAME")
        .map_err(|e| anyhow!("R2_BUCKET_NAME not set: {}", e))?;

    // Construct the R2 endpoint URL
    let endpoint_url = format!("https://{}.r2.cloudflarestorage.com", account_id);
    println!("Using R2 endpoint: {}", endpoint_url);

    // Configure AWS SDK with optimized retry settings
    let region_provider = RegionProviderChain::first_try(Region::new("auto")); // R2 specific region
    let shared_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(region_provider)
        .endpoint_url(endpoint_url.clone()) // Clone endpoint_url for use here
        .retry_config(aws_config::retry::RetryConfig::standard()
            .with_max_attempts(3) // Limit retry attempts to reduce latency on failure
            .with_initial_backoff(Duration::from_millis(100))) // Start retries quickly
        .credentials_provider(aws_sdk_s3::config::Credentials::new(
            &access_key_id,
            &secret_access_key,
            None, // session token
            None, // expiry
            "cloudflare-r2-provider", // provider name
        ))
        .load()
        .await;

    let client = S3Client::new(&shared_config);

    // Generate a unique key (filename) for the R2 object
    let file_stem = Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("upload");
    let extension = Path::new(&file_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png"); // Default to png if no extension
    let key = format!("{}-{}.{}", file_stem, Uuid::new_v4(), extension);
    println!("Generated R2 key: {}", key);

    // Create ByteStream from the file path, map error to anyhow::Error
    let body = ByteStream::from_path(Path::new(&file_path))
        .await
        .map_err(|e| anyhow!("Failed to read file '{}' for upload: {}", file_path, e))?;

    // Upload to R2
    println!("Uploading to bucket: {}", bucket_name);
    let _put_object_output = client.put_object()
        .bucket(&bucket_name)
        .key(&key)
        // Add appropriate content type if possible based on extension
        .content_type(match extension.to_lowercase().as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "application/octet-stream",
        })
        .body(body)
        .send()
        .await
        .map_err(|e| {
             let sdk_error = e.into_service_error();
             let error_message = format!("Failed to upload to R2: {:?}", sdk_error);
             eprintln!("{}", error_message);
             anyhow!(error_message) // Convert SdkError to anyhow::Error
        })?;

    println!("Successfully uploaded {} to R2 bucket {}", key, bucket_name);

    // Generate pre-signed URL with optimized configuration
    // Use shorter expiration for better security and to avoid browser caching issues
    let presigning_config = PresigningConfig::builder()
        .expires_in(Duration::from_secs(1800)) // 30 minutes - balanced for security vs usability
        .build()
        .context("Failed to create presigning config")?;

    println!("Generating pre-signed URL for key: {}", key);
    let presigned_request = client.get_object()
        .bucket(&bucket_name)
        .key(&key)
        .presigned(presigning_config)
        .await
        .context("Failed to generate pre-signed URL")?;

    let presigned_url = presigned_request.uri().to_string();
    println!("Generated pre-signed URL: {}", presigned_url);

    // Return both the key and the URL
    Ok(UploadResult {
        key,
        url: presigned_url,
    })
}
// --- /R2 Upload Command ---

#[tauri::command]
async fn open_drag_window<R: Runtime>(app: AppHandle<R>) -> Result<()> {

    // Check if the window already exists
    if let Some(window) = app.get_webview_window("drag-chat") {
        // If it exists, bring it to the front
        window.set_focus()?;
    } else {
        // If it doesn't exist, create it
        let builder = tauri::WebviewWindowBuilder::new(&app, "drag-chat", WebviewUrl::App("drag.html".into()))
            .title("Drag Chat")
            .inner_size(420.0, 300.0)
            .position(200.0, 200.0)
            .transparent(true) 
            .decorations(false) // No window decorations (title bar, etc.)
            .resizable(true)
            .skip_taskbar(true)
            .focused(true)
            .shadow(false)
            .always_on_top(true); // Let the user move it behind other windows

        // Create the window
        let _window = builder.build()?;
    }
    Ok(())
}

#[tauri::command]
async fn close_drag_window<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    if let Some(window) = app.get_webview_window("drag-chat") {
        window.close()?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn capture_region_xcap(window: Window) -> std::result::Result<UploadResult, String> {
    use xcap::Window as XcapWindow;
    use image::RgbaImage;
    use std::io::Cursor;

    // Get window title to find the corresponding xcap window
    let window_title = window.title().map_err(|e| format!("Failed to get window title: {}", e))?;
    let window_id = window.label();

    println!("Looking for window with label: {} and title: {}", window_id, window_title);

    // Find all windows
    let xcap_windows = XcapWindow::all().map_err(|e| format!("Failed to get window list: {}", e))?;
    
    // Try to find our window by title
    let mut found_window = None;
    for xcap_window in &xcap_windows {
        let title = xcap_window.title().map_err(|e| format!("Failed to get xcap window title: {}", e))?;
        println!("Found window: {}", title);
        
        // Match on partial title since Tauri might add app name to title
        if title.contains(&window_title) || title.contains(window_id) {
            found_window = Some(xcap_window.clone());
            println!("Found matching window: {}", title);
            break;
        }
    }

    // If we can't find by title, use window dimensions as fallback
    if found_window.is_none() {
        println!("Couldn't find window by title, falling back to position and size matching");
        
        // Get window geometry in physical pixels
        let position = window.outer_position().map_err(|e| format!("Failed to get window position: {}", e))?;
        let size = window.outer_size().map_err(|e| format!("Failed to get window size: {}", e))?;
        let scale_factor = window.scale_factor().map_err(|e| format!("Failed to get scale factor: {}", e))?;
        
        // Convert from logical to physical pixels
        let x = (position.x as f64 * scale_factor) as i32;
        let y = (position.y as f64 * scale_factor) as i32;
        let w = (size.width as f64 * scale_factor) as u32;
        let h = (size.height as f64 * scale_factor) as u32;
        
        println!("Looking for window at ({}, {}) with size {}x{}", x, y, w, h);
        
        // Find window with closest matching position and size
        for xcap_window in &xcap_windows {
            if xcap_window.is_minimized().map_err(|e| format!("Failed to check if window is minimized: {}", e))? {
                continue;
            }
            
            let wx = xcap_window.x().map_err(|e| format!("Failed to get xcap window x: {}", e))?;
            let wy = xcap_window.y().map_err(|e| format!("Failed to get xcap window y: {}", e))?;
            let ww = xcap_window.width().map_err(|e| format!("Failed to get xcap window width: {}", e))?;
            let wh = xcap_window.height().map_err(|e| format!("Failed to get xcap window height: {}", e))?;
            
            // Check if positions are close (within 20 pixels)
            let position_close = (wx - x).abs() < 20 && (wy - y).abs() < 20;
            // Check if sizes are close (within 20 pixels)
            let size_close = ((ww as i32) - (w as i32)).abs() < 20 && ((wh as i32) - (h as i32)).abs() < 20;
            
            if position_close && size_close {
                let title = xcap_window.title().unwrap_or_else(|_| "Unknown".to_string());
                println!("Found window by position/size: {}", title);
                found_window = Some(xcap_window.clone());
                break;
            }
        }
    }

    // Capture the window if found
    let full_img = if let Some(xcap_window) = found_window {
        xcap_window.capture_image().map_err(|e| format!("Failed to capture window image: {}", e))?
    } else {
        // Fallback to original method if window can't be found
        println!("Falling back to screen region capture");
        
        // Get window geometry in physical pixels
        let position = window.outer_position().map_err(|e| format!("Failed to get window position: {}", e))?;
        let size = window.outer_size().map_err(|e| format!("Failed to get window size: {}", e))?;
        let scale_factor = window.scale_factor().map_err(|e| format!("Failed to get scale factor: {}", e))?;
        
        // Convert from logical to physical pixels
        let x = (position.x as f64 * scale_factor) as i32;
        let y = (position.y as f64 * scale_factor) as i32;
        let w = (size.width as f64 * scale_factor) as u32;
        let h = (size.height as f64 * scale_factor) as u32;
        
        // Use the original monitor-based capture as fallback
        use xcap::Monitor;
        let monitor = Monitor::from_point(x, y).map_err(|e| format!("Failed to get monitor at point ({}, {}): {}", x, y, e))?;
        let monitor_img = monitor.capture_image().map_err(|e| format!("Failed to capture monitor image: {}", e))?;
        
        // Crop to the rectangle under our window
        image::imageops::crop_imm(&monitor_img, x as u32, y as u32, w, h).to_image()
    };

    // The rest of the process remains the same
    // Encode the image to PNG format
    let mut png_bytes = Vec::new();
    let mut cursor = Cursor::new(&mut png_bytes);
    full_img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image as PNG: {}", e))?;

    // Create a temporary file to store the PNG data
    use std::env::temp_dir;
    use std::fs::File;
    use std::io::Write;
    use uuid::Uuid;

    let temp_path = temp_dir().join(format!("region-capture-{}.png", Uuid::new_v4()));
    let temp_path_str = temp_path.to_string_lossy().to_string();
    
    let mut file = File::create(&temp_path)
        .map_err(|e| format!("Failed to create temporary file: {}", e))?;
    file.write_all(&png_bytes)
        .map_err(|e| format!("Failed to write to temporary file: {}", e))?;
    file.flush()
        .map_err(|e| format!("Failed to flush temporary file: {}", e))?;

    // Use the existing R2 upload functionality
    let upload_result = upload_image_to_r2(temp_path_str.clone())
        .await
        .map_err(|e| format!("Failed to upload image to R2: {}", e))?;

    // Optional: Clean up the temporary file (best effort)
    if let Err(e) = std::fs::remove_file(&temp_path) {
        eprintln!("Warning: Failed to remove temporary file {}: {}", temp_path_str, e);
    }

    Ok(upload_result)
}

#[cfg(target_os = "macos")]
async fn capture_region_core_graphics(window: Window)
    -> std::result::Result<UploadResult, String>
{
    use core_graphics::{
        display::{kCGWindowListOptionOnScreenBelowWindow,
                  CGWindowListCreateImage},
        geometry::{CGRect, CGPoint, CGSize},
    };
    use std::{env::temp_dir, process::Command};
    use uuid::Uuid;

    // 1. native window + frame in points
    let ns_win = window.ns_window().map_err(|e| e.to_string())? as *mut Object;
    let win_id: u32 = unsafe { msg_send![ns_win, windowNumber] };
    let frame: NSRect = unsafe { msg_send![ns_win, frame] };

    // 2. pick the actual display the window sits on
    let ns_screen: *mut Object = unsafe { msg_send![ns_win, screen] };        // nil‑safe
    let scale: f64 = unsafe { msg_send![ns_screen, backingScaleFactor] };

    // 3. flip Y once (points → points, top‑left origin)
    let screen_frame: NSRect = unsafe { msg_send![ns_screen, frame] };
    let rect_pts = CGRect::new(
        &CGPoint::new(frame.origin.x,                      // X unchanged
                      screen_frame.size.height - frame.origin.y - frame.size.height),
        &CGSize::new(frame.size.width, frame.size.height), // full window, no header math
    );

    // 4. We don't need to create or keep a CGImage reference - removed that part

    // 5. Save directly to PNG using screencapture 
    let dest = temp_dir().join(format!("region-{}.png", Uuid::new_v4()));
    let dest_path = dest.to_string_lossy().to_string();
    
    // Let Core Graphics write directly to the file
    let output = Command::new("screencapture")
        .args([
            "-x",       // No sound
            "-o",       // No shadow
            "-R", &format!("{},{},{},{}", 
                rect_pts.origin.x, rect_pts.origin.y,
                rect_pts.size.width, rect_pts.size.height),
            &dest_path
        ])
        .output()
        .map_err(|e| format!("Failed to capture: {}", e))?;
    
    if !output.status.success() {
        return Err(format!("screencapture command failed: {}", 
            String::from_utf8_lossy(&output.stderr)));
    }

    // 6. upload (your existing helper)
    let res = upload_image_to_r2(dest_path)
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dest);
    Ok(res)
}

#[tauri::command]
async fn capture_region_and_upload(window: Window) -> std::result::Result<UploadResult, String> {
    #[cfg(target_os = "macos")]
    {
        // Added curly braces for clarity and to ensure return is from this block
        return capture_region_core_graphics(window).await;
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Added curly braces for clarity and to ensure return is from this block
        return capture_region_xcap(window).await; // existing body moved here
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file variables into environment
    dotenvy::dotenv().expect("Failed to load .env file. Please ensure it exists in src-tauri/");

    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_notes_table",
            sql: "CREATE TABLE IF NOT EXISTS notes (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      title TEXT NOT NULL,
                      body TEXT NOT NULL,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                  );",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:notes.db", migrations)
                .build()
        )
        .invoke_handler(tauri::generate_handler![
            greet,
            open_popup_window,
            close_popup_window,
            chat,
            upload_image_to_r2,
            chat_mastra,
            open_drag_window,
            close_drag_window,
            capture_region_and_upload
        ])
        // Add setup to ensure AppHandle is available for chat_mastra
        .setup(|app| {
            // Allow access to the screenshots directory
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_fs::FsExt;
                let scope = app.fs_scope();
                let _ = scope.allow_directory("/Users/josiah/Library/Application Support/com.zen.app/tauri-plugin-screenshots", true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
