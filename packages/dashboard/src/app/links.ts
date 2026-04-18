import { linkFor } from "rwsdk/router";
import type * as Worker from "@/worker";

type App = typeof Worker.default;

export const link = linkFor<App>();
