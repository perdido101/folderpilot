import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Inbox } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { ThemeSync } from "@/components/theme-sync";
import { Toaster } from "@/components/toaster";
import { AuditPage } from "@/features/audit/audit-page";
import { CategoriesPage } from "@/features/categories/categories-page";
import { DuplicatesPage } from "@/features/cleanup/duplicates-page";
import { FilesPage } from "@/features/files/files-page";
import { GlobalQuickLook } from "@/features/files/quick-look";
import { MiniPage } from "@/features/mini/mini-page";
import { NeedsReviewPage } from "@/features/review/needs-review-page";
import { RulesPage } from "@/features/rules/rules-page";
import { SettingsPage } from "@/features/settings/settings-page";
import { TrashPage } from "@/features/trash/trash-page";
import { PlaceholderPage } from "@/pages/placeholder-page";

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <FilesPage /> },
      { path: "review", element: <NeedsReviewPage /> },
      { path: "categories", element: <CategoriesPage /> },
      { path: "rules", element: <RulesPage /> },
      { path: "duplicates", element: <DuplicatesPage /> },
      { path: "audit", element: <AuditPage /> },
      { path: "trash", element: <TrashPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <PlaceholderPage icon={Inbox} title="Not found" description="This page doesn't exist." /> },
    ],
  },
  {
    // Standalone compact layout — later the Tauri tray popup.
    path: "/mini",
    element: (
      <>
        <MiniPage />
        <GlobalQuickLook />
        <Toaster />
      </>
    ),
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
