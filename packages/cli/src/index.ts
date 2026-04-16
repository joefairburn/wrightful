import { Command } from "commander";
import { uploadCommand } from "./commands/upload.js";

const program = new Command()
  .name("greenroom")
  .description("Upload Playwright test results to your Greenroom dashboard")
  .version("0.0.0");

program.addCommand(uploadCommand);
program.parse();
