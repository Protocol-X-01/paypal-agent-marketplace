import { connection, type NextRequest } from "next/server";
import { customerAuth } from "@/lib/customer-auth/controller";

export async function GET(request: NextRequest) {
  await connection();
  return customerAuth.callback(request);
}
