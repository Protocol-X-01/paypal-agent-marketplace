import { connection } from "next/server";
import { nativeCustomerAuth } from "@/lib/customer-auth/native-runtime";

export async function GET(request: Request) {
  await connection();
  return nativeCustomerAuth.authorizeGet(request);
}

export async function POST(request: Request) {
  return nativeCustomerAuth.authorizePost(request);
}
