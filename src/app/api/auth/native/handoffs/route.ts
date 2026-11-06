import { nativeCustomerAuth } from "@/lib/customer-auth/native-runtime";

export async function POST(request: Request) {
  return nativeCustomerAuth.handoffs(request);
}
