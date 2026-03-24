"use client";

/**
 * ModeToggle.tsx
 *
 * Student ↔ Professional mode switch.
 * Controls which system prompt the backend uses.
 */

import { Mode } from "@/lib/api";

interface ModeToggleProps {
  mode:     Mode;
  onChange: (mode: Mode) => void;
  disabled?: boolean;
}

export default function ModeToggle({ mode, onChange, disabled }: ModeToggleProps) {
  return (
    <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-full p-1">
      <button
        onClick={() => onChange("student")}
        disabled={disabled}
        className={`
          px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200
          ${mode === "student"
            ? "bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm"
            : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
      >
        Student
      </button>
      <button
        onClick={() => onChange("professional")}
        disabled={disabled}
        className={`
          px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200
          ${mode === "professional"
            ? "bg-white dark:bg-gray-700 text-purple-600 dark:text-purple-400 shadow-sm"
            : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
      >
        Professional
      </button>
    </div>
  );
}