import { redirect } from "next/navigation";

/* The project list is the home page; old links keep their query (?new=1, ?q=). */
export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of [value ?? []].flat()) query.append(key, item);
  }
  const qs = query.toString();
  redirect(qs ? `/?${qs}` : "/");
}
