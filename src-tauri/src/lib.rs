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
        "gpt-4o-mini",
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
    messages_to_send.push(ChatMessage { role: "user".to_string(), content: prompt });

    // Add "stream": true to the request body
    let request_body = serde_json::json!({
        "messages": messages_to_send,
        "stream": true // Request streaming
    });

    println!("Sending streaming request to Mastra: {:?}", request_body);

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

    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk_bytes) => {
                // Attempt to parse the chunk as JSON
                // This assumes Mastra sends JSON objects per chunk, like {"text": "..."}
                // Adjust parsing based on Mastra's actual streaming format (e.g., SSE parsing if needed)
                match serde_json::from_slice::<MastraStreamChunk>(&chunk_bytes) {
                    Ok(parsed_chunk) => {
                         if let Some(text) = parsed_chunk.text {
                            // Emit the text chunk to the frontend
                             println!("Emitting chunk: {}", text); // Debugging
                            window.emit("chat_chunk", &text).map_err(|e| format!("Failed to emit chat chunk event: {}", e))?;
                         }
                         // Check for finish reason if Mastra sends one in the stream
                         if let Some(reason) = parsed_chunk.finish_reason {
                            println!("Stream finished with reason: {}", reason); // Debugging
                            break; // Exit loop if finish reason is received
                         }
                    }
                    Err(e) => {
                        // If parsing fails, maybe it's just raw text? Or an error in format.
                        // Log the error and potentially emit the raw chunk or an error message.
                        eprintln!("Failed to parse stream chunk as JSON: {}. Raw chunk: {:?}", e, String::from_utf8_lossy(&chunk_bytes));
                         // Optionally emit the raw text if it looks like text
                        // let raw_text = String::from_utf8_lossy(&chunk_bytes).to_string();
                        // window.emit("chat_chunk", &raw_text)?;
                        // Or emit a specific parsing error
                        let parse_error_msg = format!("Failed to parse stream chunk: {}", e);
                         window.emit("chat_stream_error", &parse_error_msg).map_err(|e| format!("Failed to emit parse error event: {}", e))?;
                         // Decide whether to continue or break on parse error
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
            // You can perform initial setup here if needed
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
