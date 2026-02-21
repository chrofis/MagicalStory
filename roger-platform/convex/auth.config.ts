// Clerk authentication configuration for Convex
// Documentation: https://docs.convex.dev/auth/clerk

export default {
  providers: [
    // Production Clerk instance
    {
      domain: "https://clerk.magicalstory.ch",
      applicationID: "convex",
    },
    // Development Clerk instance
    {
      domain: "https://diverse-katydid-77.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
};
