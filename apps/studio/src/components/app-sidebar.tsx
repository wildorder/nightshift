/**
 * The Studio's sidebar (P13, D-P13-05): the project switcher, the navigation,
 * and the signed-in user with the theme and sign-out.
 */
import {
  ChevronsUpDown,
  FolderGit2,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  Play,
  Settings,
  Sun,
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { useProjects } from "../projects.js";
import { useStudio } from "../studio.js";
import { type ThemeChoice, useTheme } from "./theme-provider.js";

const initialsOf = (text: string): string =>
  text
    .split(/[@.\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const ProjectSwitcher = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const projects = useProjects();
  const current = projects.data?.find((p) => p.projectId === projectId);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label="Switch project">
              <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <FolderGit2 className="size-4" />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">{current?.name ?? "Nightshift"}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {current === undefined ? "All projects" : "Project"}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Projects
            </DropdownMenuLabel>
            {(projects.data ?? []).map((project) => (
              <DropdownMenuItem
                key={project.projectId}
                onSelect={() => void navigate(`/projects/${project.projectId}`)}
              >
                {project.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void navigate("/")}>All projects</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

const THEMES: readonly {
  readonly value: ThemeChoice;
  readonly label: string;
  readonly icon: typeof Sun;
}[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const UserMenu = () => {
  const { identity, orgId, signOut } = useStudio();
  const { choice, setChoice } = useTheme();
  const who = identity.email ?? identity.subject ?? "signed in";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label="Account">
              <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-xs font-medium">
                {initialsOf(who)}
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium">{who}</span>
                <span
                  className="truncate font-mono text-xs text-muted-foreground"
                  title="Acting organisation"
                >
                  {orgId ?? identity.activeOrgClaim ?? "no org yet"}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="min-w-56">
            <DropdownMenuLabel className="truncate">{who}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={choice}
                  onValueChange={(v) => setChoice(v as ThemeChoice)}
                >
                  {THEMES.map(({ value, label, icon: Icon }) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      <Icon className="size-4" /> {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOut className="size-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

export const AppSidebar = () => {
  const { projectId } = useParams();
  const location = useLocation();
  const items = [
    { to: "/", label: "Projects", icon: LayoutGrid, active: location.pathname === "/" },
    ...(projectId === undefined
      ? []
      : [
          {
            to: `/projects/${projectId}`,
            label: "Runs",
            icon: Play,
            active:
              location.pathname.startsWith(`/projects/${projectId}`) &&
              !location.pathname.endsWith("/settings"),
          },
        ]),
    {
      to: "/settings",
      label: "Settings",
      icon: Settings,
      active: location.pathname === "/settings",
    },
  ];
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <ProjectSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Studio</SidebarGroupLabel>
          <SidebarMenu>
            {items.map(({ to, label, icon: Icon, active }) => (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton asChild isActive={active} tooltip={label}>
                  <Link to={to}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};
