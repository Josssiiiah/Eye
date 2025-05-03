use tauri::{AppHandle, Manager, Result, Runtime, WebviewUrl, Window, Emitter};
use tauri_plugin_sql::{Migration, MigrationKind};
use std::env;
// Removed unused vibrancy imports as they're commented out in the code
use serde::{Deserialize, Serialize};
use reqwest;
use tokio_stream::StreamExt;
use reqwest::Response;
use bytes::Bytes;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Define a struct to match the message format expected by openai_rust and useChat
#[derive(Serialize, Deserialize, Debug, Clone)] // Add Clone
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
    app: AppHandle<R>,
) -> std::result::Result<(), String> {
    let mastra_endpoint = "http://localhost:4111/api/agents/weatherAgent/generate";
    let client = reqwest::Client::new();

    let mut messages_to_send = messages_history;
    
    // Check if the prompt contains an image (markdown format: ![alt](data:image/png;base64,...))
    let mut image_url = None;
    let prompt_text = if prompt.contains("![Screenshot](data:image/") {
        // Extract the base64 image data
        if let Some(start_idx) = prompt.find("data:image/") {
            if let Some(end_idx) = prompt[start_idx..].find(")") {
                let full_image_url = &prompt[start_idx..start_idx + end_idx];
                image_url = Some(full_image_url.to_string());
                
                // Remove the image markdown from the prompt
                prompt.replace(&format!("![Screenshot]({})", full_image_url), "")
                    .trim()
                    .to_string()
            } else {
                prompt
            }
        } else {
            prompt
        }
    } else {
        prompt
    };
    
    // Add the user message, potentially with an image
    messages_to_send.push(ChatMessage { 
        role: "user".to_string(), 
        content: prompt_text,
        image_url,
    });

    // Format messages for Mastra's API format - exactly like the bird-checker example 
    let formatted_messages = messages_to_send.iter().map(|msg| {
        let mut content_array = Vec::new();
        
        // Add image if present (should come first based on examples)
        if let Some(img_url) = &msg.image_url {
            content_array.push(serde_json::json!({
                "type": "image",
                "image": img_url,
                "detail": "low"  // Set to "low" to save tokens and speed up responses
            }));
        }
        
        // Add text content
        content_array.push(serde_json::json!({
            "type": "text",
            "text": msg.content
        }));
        
        serde_json::json!({
            "role": msg.role,
            "content": content_array
        })
    }).collect::<Vec<_>>();

    // Add "stream": true to the request body
    let request_body = serde_json::json!({
        "messages": formatted_messages,
        "stream": true // Request streaming
    });

    println!("Sending request to Mastra. Message format:");
    for (i, msg) in formatted_messages.iter().enumerate() {
        println!("Message {}: {}", i, serde_json::to_string_pretty(msg).unwrap_or_default());
    }

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
    let mut has_emitted = false; // Track if we've emitted any content

    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk_bytes) => {
                // Convert the bytes to a string
                let chunk_str = String::from_utf8_lossy(&chunk_bytes).to_string();
                println!("Raw chunk: {}", chunk_str); // Debug logging
                
                // Append to our buffer
                buffer.push_str(&chunk_str);
                
                // First, check if the buffer contains a complete JSON object
                if !has_emitted && buffer.starts_with('{') && buffer.ends_with('}') {
                    // Try parsing as a complete JSON response
                    match serde_json::from_str::<serde_json::Value>(&buffer) {
                        Ok(json_value) => {
                            if let Some(text) = json_value.get("text").and_then(|t| t.as_str()) {
                                // Found the text in the top-level object
                                println!("Emitting complete response: {}", text);
                                window.emit("chat_chunk", text).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                has_emitted = true;
                            }
                        },
                        Err(_) => {
                            // Not a complete valid JSON, might be streaming - continue to SSE processing
                        }
                    }
                }
                
                // Process any complete SSE lines
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string(); // Create an owned String here
                    buffer = buffer[pos + 1..].to_string();
                    
                    // Skip empty lines and comments
                    if line.is_empty() || line.starts_with(':') {
                        continue;
                    }
                    
                    // Check for data prefix and process it
                    if line.starts_with("data: ") {
                        let data = &line[6..]; // Skip "data: " prefix
                        
                        // Check if it's an empty data or [DONE] marker
                        if data == "[DONE]" {
                            println!("Stream complete marker received");
                            continue;
                        }
                        
                        // Try to parse as JSON
                        match serde_json::from_str::<serde_json::Value>(data) {
                            Ok(json_value) => {
                                if let Some(text) = json_value.get("text").and_then(|t| t.as_str()) {
                                    // Valid text chunk found, emit it
                                    println!("Emitting chunk: {}", text);
                                    window.emit("chat_chunk", text).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                    has_emitted = true;
                                } else if let Some(finish_reason) = json_value.get("finishReason") {
                                    // End of stream with finish reason
                                    println!("Stream finished with reason: {:?}", finish_reason);
                                } else {
                                    // Unknown format but valid JSON
                                    println!("Unknown JSON format: {}", json_value);
                                }
                            },
                            Err(e) => {
                                // Sometimes data might come in raw text instead of JSON
                                if !data.is_empty() && !data.starts_with('{') && !data.starts_with('[') {
                                    // Assume it's plain text if not starting with JSON markers
                                    println!("Emitting raw text chunk: {}", data);
                                    window.emit("chat_chunk", data).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                                    has_emitted = true;
                                } else {
                                    // It's a parsing error for what should be JSON
                                    println!("Failed to parse data as JSON: {}. Raw data: {}", e, data);
                                }
                            }
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

    // Try one more time with any remaining buffer content
    if !has_emitted && !buffer.is_empty() {
        match serde_json::from_str::<serde_json::Value>(&buffer) {
            Ok(json_value) => {
                if let Some(text) = json_value.get("text").and_then(|t| t.as_str()) {
                    println!("Emitting final buffer content: {}", text);
                    window.emit("chat_chunk", text).map_err(|e| format!("Failed to emit chat chunk: {}", e))?;
                }
            },
            Err(e) => {
                println!("Could not parse remaining buffer as JSON: {}", e);
            }
        }
    }

    // Signal the end of the stream
    println!("Emitting stream end"); // Debugging
    window.emit("chat_stream_end", ()).map_err(|e| format!("Failed to emit stream end event: {}", e))?;
    Ok(()) // Return Ok(()) as the stream finished successfully
}
// --- /MODIFIED COMMAND ---

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
            chat_mastra
        ])
        // Add setup to ensure AppHandle is available for chat_mastra
        .setup(|app| {
            // Allow access to the screenshots directory
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_fs::FsExt;
                let scope = app.fs_scope();
                scope.allow_directory("/Users/josiah/Library/Application Support/com.zen.app/tauri-plugin-screenshots", true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
