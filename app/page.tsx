import { getChatGPTUser } from "./chatgpt-auth";
import SplitApp from "./split-app";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return <SplitApp canSync={Boolean(user)} />;
}
