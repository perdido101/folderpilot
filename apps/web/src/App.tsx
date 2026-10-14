import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Inbox } from "lucide-react";
import { Gate } from "@/app/gate";
import { AppShell } from "@/components/layout/app-shell";
import { ThemeSync } from "@/components/theme-sync";
import { Toaster } from "@/components/toaster";
import { MembersPage } from "@/features/admin/members-page";
import { AcceptInvitePage } from "@/features/auth/accept-invite-page";
import { CreateOrgPage } from "@/features/auth/create-org-page";
import { SignInPage } from "@/features/auth/sign-in-page";
import { SignUpPage } from "@/features/auth/sign-up-page";
import { AuditPage } from "@/features/audit/audit-page";
import { CategoriesPage } from "@/features/categories/categories-page";
import { DuplicatesPage } from "@/features/cleanup/duplicates-page";
import { FilesPage } from "@/features/files/files-page";
import { GlobalQuickLook } from "@/features/files/quick-look";
import { MiniPage } from "@/features/mini/mini-page";
import { ApprovalsPage } from "@/features/pages/approvals-page";
import { RecentPage } from "@/features/pages/recent-page";
import { SharedPage } from "@/features/pages/shared-page";
import { NeedsReviewPage } from "@/features/review/needs-review-page";
import { RulesPage } from "@/features/rules/rules-page";
import { SettingsPage } from "@/features/settings/settings-page";
import { TrashPage } from "@/features/trash/trash-page";
import { PlaceholderPage } from "@/pages/placeholder-page";

function NotFound() {
  const { t } = useTranslation("pages");
  return <PlaceholderPage icon={Inbox} title={t("notFound.title")} description={t("notFound.description")} />;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } });

const router = createBrowserRouter(
  [
    { path: "/sign-in", element: <SignInPage /> },
    { path: "/sign-up", element: <SignUpPage /> },
    { path: "/invite/:id", element: <AcceptInvitePage /> },
    { path: "/onboarding", element: <CreateOrgPage /> },
    {
      path: "/",
      element: (
        <Gate>
          <AppShell />
        </Gate>
      ),
      children: [
        { index: true, element: <FilesPage /> },
        { path: "review", element: <NeedsReviewPage /> },
        { path: "recent", element: <RecentPage /> },
        { path: "categories", element: <CategoriesPage /> },
        { path: "duplicates", element: <DuplicatesPage /> },
        { path: "rules", element: <RulesPage /> },
        { path: "approvals", element: <ApprovalsPage /> },
        { path: "audit", element: <AuditPage /> },
        { path: "shared", element: <SharedPage /> },
        { path: "trash", element: <TrashPage /> },
        { path: "settings", element: <SettingsPage /> },
        { path: "admin", element: <MembersPage /> },
        { path: "*", element: <NotFound /> },
      ],
    },
    {
      // Standalone compact layout — later the desktop tray popup (Phase 12).
      path: "/mini",
      element: (
        <>
          <MiniPage />
          <GlobalQuickLook />
          <Toaster />
        </>
      ),
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, "") || "/" },
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
