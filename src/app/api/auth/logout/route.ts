import { NextRequest } from "next/server";
import { customerAuth } from "@/lib/customer-auth/controller";

export async function POST(request: NextRequest) { return customerAuth.logout(request); }
