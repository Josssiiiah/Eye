import { useState, useCallback } from "react";
import Database from "@tauri-apps/plugin-sql";

// Define the Note type mirroring what's used in the app
export interface Note {
  id: number;
  title: string;
  body: string;
}

export function useDatabase() {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get database connection
  const getDb = useCallback(async () => {
    try {
      return await Database.load("sqlite:notes.db");
    } catch (err) {
      console.error("Failed to connect to database:", err);
      setError("Database connection failed");
      throw err;
    }
  }, []);

  // Fetch all notes
  const fetchNotes = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const db = await getDb();
      const result = await db.select<Note[]>(
        "SELECT id, title, body FROM notes ORDER BY id DESC"
      );
      setIsLoading(false);
      return result;
    } catch (err) {
      console.error("Error fetching notes:", err);
      setError("Failed to fetch notes");
      setIsLoading(false);
      return [];
    }
  }, [getDb]);

  // Add a new note
  const addNote = useCallback(
    async (title: string, body: string) => {
      setError(null);

      if (!title.trim()) {
        setError("Title cannot be empty.");
        return false;
      }

      try {
        const db = await getDb();
        await db.execute("INSERT INTO notes (title, body) VALUES ($1, $2)", [
          title,
          body,
        ]);
        return true;
      } catch (err) {
        console.error("Error adding note:", err);
        setError("Failed to add note");
        return false;
      }
    },
    [getDb]
  );

  // Delete a note
  const deleteNote = useCallback(
    async (id: number) => {
      setError(null);

      try {
        const db = await getDb();
        await db.execute("DELETE FROM notes WHERE id = $1", [id]);
        return true;
      } catch (err) {
        console.error("Error deleting note:", err);
        setError("Failed to delete note");
        return false;
      }
    },
    [getDb]
  );

  // Copy note content
  const copyNoteContent = useCallback(async (textToCopy: string) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      return true;
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
      setError("Failed to copy to clipboard");
      return false;
    }
  }, []);

  return {
    isLoading,
    error,
    fetchNotes,
    addNote,
    deleteNote,
    copyNoteContent,
  };
}
