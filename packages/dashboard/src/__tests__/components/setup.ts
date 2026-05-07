import "@testing-library/jest-dom/vitest";
import { afterEach } from "vite-plus/test";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
