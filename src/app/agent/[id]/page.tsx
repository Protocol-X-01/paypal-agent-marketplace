import { redirect } from "next/navigation";

export const instant = false;

export default async function AgentPage() {
  redirect("/");
}
