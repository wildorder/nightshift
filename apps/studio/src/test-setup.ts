/** Unmount after every test: without vitest globals, Testing Library cannot do it itself. */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
