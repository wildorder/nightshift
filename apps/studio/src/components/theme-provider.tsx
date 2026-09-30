/**
 * Light, dark, or the system's choice (P13, D-P13-04). The choice is a class on
 * `<html>`; what each theme looks like is `theme.css`'s alone.
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export const THEME_KEY = "nightshift.studio.theme";

interface ThemeState {
  readonly choice: ThemeChoice;
  readonly resolved: "light" | "dark";
  setChoice(choice: ThemeChoice): void;
}

const ThemeContext = createContext<ThemeState | undefined>(undefined);

const systemPrefersDark = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;

const stored = (): ThemeChoice => {
  const value = typeof window === "undefined" ? null : window.localStorage.getItem(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
};

export const ThemeProvider = ({ children }: { readonly children: ReactNode }) => {
  const [choice, setChoiceState] = useState<ThemeChoice>(stored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (query === undefined) return;
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  const setChoice = (next: ThemeChoice) => {
    if (next === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, next);
    setChoiceState(next);
  };

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeState => {
  const theme = useContext(ThemeContext);
  if (theme === undefined) throw new Error("useTheme outside a ThemeProvider");
  return theme;
};
