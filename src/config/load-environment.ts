// Imported first by every entry point, before any module reads process.env.
import { loadEnvironmentFile } from "./environment-file.js";

loadEnvironmentFile();
