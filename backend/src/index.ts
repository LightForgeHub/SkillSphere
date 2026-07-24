import { createApp } from "./app";
import { prisma } from "./prisma";

const PORT = process.env.PORT ?? 4000;

async function main() {
  const { app } = await createApp(prisma);

  app.listen(PORT, () => {
    console.log(`🚀 SkillSphere API running at http://localhost:${PORT}/graphql`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
