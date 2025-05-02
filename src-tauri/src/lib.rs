use tauri::{AppHandle, Manager, Result, Runtime, WebviewUrl};
use tauri_plugin_sql::{Migration, MigrationKind};
use std::env;
// Removed unused vibrancy imports as they're commented out in the code
use serde::{Deserialize, Serialize};

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
            chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
