/**
 * The dashboard's frame (P13, D-P13-05): the sidebar, the header with where you
 * are, and the page inside.
 */
import { Outlet } from "react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "./components/app-header.js";
import { AppSidebar } from "./components/app-sidebar.js";

export { useProjects } from "./projects.js";

export const Shell = () => (
  <SidebarProvider>
    <AppSidebar />
    <SidebarInset>
      <AppHeader />
      <div className="flex-1 p-4 md:p-6">
        <div className="mx-auto w-full max-w-7xl">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  </SidebarProvider>
);
