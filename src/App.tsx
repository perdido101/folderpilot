import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Copy, Inbox, ScrollText, Settings, Shapes, Trash2, Workflow } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { ThemeSync } from "@/components/theme-sync";
import { FilesPage } from "@/features/files/files-page";
import { PlaceholderPage } from "@/pages/placeholder-page";

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <FilesPage /> },
      {
        path: "review",
        element: <PlaceholderPage icon={Inbox} phase={3} title="Needs Review" description="Files the AI wasn't sure about land here for you to decide." />,
      },
      {
        path: "categories",
        element: <PlaceholderPage icon={Shapes} phase={3} title="Categories" description="Browse files by what they are: invoices, contracts, photos, screenshots…" />,
      },
      {
        path: "rules",
        element: <PlaceholderPage icon={Workflow} phase={5} title="Rules" description="IF → THEN rules, or plain-language rules like “screenshots go to /Temp”." />,
      },
      {
        path: "duplicates",
        element: <PlaceholderPage icon={Copy} phase={2} title="Duplicates & Bad Files" description="Exact and near-duplicates, blurry, dark and tiny photos — reviewed one by one." />,
      },
      {
        path: "audit",
        element: <PlaceholderPage icon={ScrollText} phase={4} title="Audit Log" description="Every change, who made it and why — with undo." />,
      },
      {
        path: "trash",
        element: <PlaceholderPage icon={Trash2} phase={4} title="Trash" description="Trashed files are moved to a hidden folder and can always be restored." />,
      },
      {
        path: "settings",
        element: <PlaceholderPage icon={Settings} phase={3} title="Settings" description="Choose your AI: local Ollama, or your own OpenAI-compatible or Anthropic endpoint." />,
      },
      {
        path: "*",
        element: <PlaceholderPage icon={Inbox} title="Not found" description="This page doesn't exist." />,
      },
    ],
  },
]);

export function App() {
  return (
    <>
      <ThemeSync />
      <RouterProvider router={router} />
    </>
  );
}
