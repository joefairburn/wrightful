import { Command } from "commander";
import { uploadCommand } from "./commands/upload.js";

const program = new Command()
  .name("wrightful")
  .description("Upload Playwright test results to your Wrightful dashboard")
  .version("0.1.0");

program.addCommand(uploadCommand);
program.parse();
