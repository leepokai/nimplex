import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema.ts", "./src/auth-schema.ts"],
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://nimplex:nimplex@localhost:5433/nimplex",
  },
});
