import { createServer } from "http";
import { createApp } from "./app";
import { prisma } from "./prisma";
import { createSessionHub } from "./ws/sessionHub";
import { publishSessionStatus } from "./sessionEvents";

const PORT = process.env.PORT ?? 4000;

async function main() {
  const { app } = await createApp(prisma);
  const httpServer = createServer(app);
  const sessionHub = createSessionHub(httpServer, {
    fallbackSettlement: async (sessionId) => {
      const result = await prisma.session.updateMany({
        where: { sessionId, status: "ACTIVE" },
        data: { status: "COMPLETED", endTime: new Date() },
      });

      if (result.count > 0) {
        publishSessionStatus("SESSION_ENDED", sessionId, {
          reason: "peer_disconnect_timeout",
          settled: true,
        });
      }
    },
  });

  httpServer.listen(PORT, () => {
    console.log(`🚀 SkillSphere API running at http://localhost:${PORT}/graphql`);
    console.log(`🔌 Session status WS at http://localhost:${PORT}/session`);
  });

  const shutdown = async () => {
    // sessionHub.close() also closes the HTTP server Socket.IO is attached to
    await sessionHub.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
