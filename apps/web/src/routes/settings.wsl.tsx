import { createFileRoute } from "@tanstack/react-router";
import { WslSettings } from "../components/settings/WslSettings";

export const Route = createFileRoute("/settings/wsl")({ component: WslSettings });
