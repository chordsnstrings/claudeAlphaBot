import { redirect } from "next/navigation";

/** Root `/` redirects to `/dashboard` per nav default landing spec. */
export default function RootPage(): never {
  redirect("/dashboard");
}
