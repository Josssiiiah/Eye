use tauri::{AppHandle, Manager, Result, Runtime, WebviewUrl, Window, Emitter};
use tauri_plugin_sql::{Migration, MigrationKind};
use std::env;
// Removed unused vibrancy imports as they're commented out in the code
use serde::{Deserialize, Serialize};
use reqwest;
use tokio_stream::StreamExt;
use reqwest::Response;
use std::path::Path;
use uuid::Uuid;
use std::time::Duration; // Import Duration for presigning

// AWS / R2 Imports
use aws_config::meta::region::RegionProviderChain;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::presigning::PresigningConfig; // Import PresigningConfig
use anyhow::{anyhow, Context}; // Import anyhow and Context

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
    let client = reqwest::Client::new();

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

    // Ensure the popup window exists before proceeding
    let window = app.get_webview_window("popup").ok_or_else(|| "Popup window not found".to_string())?;

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
    let mut buffer = String::new();

    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk_bytes) => {
                // Convert the bytes to a string
                let chunk_str = String::from_utf8_lossy(&chunk_bytes).to_string();
                println!("Raw chunk: {}", chunk_str); // Debug logging

                // Append to our buffer
                buffer.push_str(&chunk_str);

                // Process any complete lines - Mastra uses a custom format
                while let Some(pos) = buffer.find("\n") {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    // Skip empty lines
                    if line.is_empty() {
                        continue;
                    }

                    // Parse the Mastra streaming format with different prefixes
                    // Format appears to be: prefix:content where prefix is f, 0, e, or d
                    if line.len() >= 2 && line.chars().nth(1) == Some(':') {
                        let prefix = line.chars().next().unwrap_or('?');
                        let content = &line[2..];

                        match prefix {
                            'f' => {
                                // First message, typically contains messageId
                                println!("Message start: {}", content);
                                // No need to emit this part
                            },
                            '0' => {
                                // Text content chunk
                                // Parse the string content - it should be JSON encoded
                                if let Ok(content_json) = serde_json::from_str::<serde_json::Value>(content) {
                                    if let Some(text) = content_json.as_str() {
                                        println!("Emitting text chunk: {}", text);
                                        window.emit("chat_chunk", text).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                    }
                                } else {
                                    // If not valid JSON, just emit the raw content without the quotes
                                    // This is a fallback but shouldn't normally be needed
                                    if content.starts_with('"') && content.ends_with('"') && content.len() >= 2 {
                                        let clean_content = &content[1..content.len()-1];
                                        println!("Emitting cleaned text chunk: {}", clean_content);
                                        window.emit("chat_chunk", clean_content).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                    }
                                }
                            },
                            'e' | 'd' => {
                                // End message or Done message
                                println!("Stream end marker: {} - {}", prefix, content);
                                // No need to emit this directly
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
                                window.emit("chat_stream_error", error_content).map_err(|e| format!("Failed to emit error: {}", e))?;
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
                            continue;
                        }

                        // Try to parse data content
                        if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(text) = json_value.get("text").and_then(|t| t.as_str()) {
                                println!("Emitting SSE chunk: {}", text);
                                window.emit("chat_chunk", text).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                            }
                        } else if !data.is_empty() {
                            println!("Emitting raw SSE data: {}", data);
                            window.emit("chat_chunk", data).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                        }
                    }
                }
            }
            Err(e) => {
                // Error reading from the stream
                let stream_error_msg = format!("Error reading stream from Mastra: {}", e);
                eprintln!("{}", stream_error_msg);
                window.emit("chat_stream_error", &stream_error_msg).map_err(|e| format!("Failed to emit stream error event: {}", e))?;
                // Terminate processing on stream error
                return Err(stream_error_msg);
            }
        }
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

    // Configure AWS SDK
    let region_provider = RegionProviderChain::first_try(Region::new("auto")); // R2 specific region
    let shared_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(region_provider)
        .endpoint_url(endpoint_url.clone()) // Clone endpoint_url for use here
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
    let put_object_output = client.put_object()
        .bucket(&bucket_name)
        .key(&key)
        // Consider adding content type if known, e.g., .content_type("image/png")
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

    // Generate pre-signed URL after successful upload
    let presigning_config = PresigningConfig::expires_in(Duration::from_secs(3600)) // e.g., 1 hour validity
        .context("Failed to create presigning config")?; // Use anyhow::Context for better error

    println!("Generating pre-signed URL for key: {}", key);
    let presigned_request = client.get_object()
        .bucket(&bucket_name)
        .key(&key)
        .presigned(presigning_config)
        .await
        .context("Failed to generate pre-signed URL")?; // Use anyhow::Context

    let presigned_url = presigned_request.uri().to_string();
    println!("Generated pre-signed URL: {}", presigned_url);

    // Return both the key and the URL
    Ok(UploadResult {
        key,
        url: presigned_url,
    })
}
// --- /R2 Upload Command ---

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
            chat_mastra
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
