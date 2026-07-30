import { gql } from "graphql-tag";

export const typeDefs = gql`
  enum SessionStatus {
    ACTIVE
    PAUSED
    COMPLETED
    REFUNDED
  }

  enum TransactionTypeEnum {
    ESCROW_FUNDED
    PAYMENT_RELEASED
    REFUND_ISSUED
    FEE_COLLECTED
  }

  type User {
    id: ID!
    walletAddress: String!
    createdAt: String!
    expert: ExpertType
  }

  type ExpertType {
    id: ID!
    userId: String!
    name: String!
    bio: String!
    skills: [String!]!
    categories: [String!]!
    hourlyRate: Float!
    rating: Float!
    reviewCount: Int!
    isAvailable: Boolean!
    createdAt: String!
    updatedAt: String!
    reviews: [ReviewType!]!
  }

  type SessionType {
    sessionId: ID!
    seekerAddress: String!
    expertAddress: String!
    expertId: String!
    status: SessionStatus!
    escrowAmount: String!
    startTime: String
    endTime: String
    createdAt: String!
    updatedAt: String!
    expert: ExpertType!
    review: ReviewType
    transactions: [TransactionType!]!
  }

  type ReviewType {
    id: ID!
    rating: Int!
    content: String!
    sessionId: String!
    seekerAddress: String!
    expertId: String!
    createdAt: String!
    session: SessionType!
    expert: ExpertType!
  }

  type TransactionType {
    id: ID!
    txHash: String!
    sessionId: String!
    amount: String!
    type: TransactionTypeEnum!
    ledgerTime: String!
    createdAt: String!
    session: SessionType!
  }

  type UpdateProfileResult {
    success: Boolean!
    expert: ExpertType
    error: String
  }

  type SubmitReviewResult {
    success: Boolean!
    review: ReviewType
    error: String
  }

  input ExpertInput {
    name: String
    bio: String
    skills: [String!]
    categories: [String!]
    hourlyRate: Float
    isAvailable: Boolean
  }

  input ReviewInput {
    sessionId: String!
    rating: Int!
    content: String!
  }

  type Query {
    """
    Returns a paginated list of experts, filtered optionally by category and search.
    """
    experts(category: String, search: String, limit: Int, offset: Int): [ExpertType!]!

    """
    Returns a single expert by their ID.
    """
    expert(id: ID!): ExpertType

    """
    Returns a session by its ID.
    """
    session(id: ID!): SessionType

    """
    Returns a single expert by their wallet address.
    """
    expertByWallet(walletAddress: String!): ExpertType
  }

  type Mutation {
    """
    Update an expert's profile. Requires valid wallet signature in headers.
    """
    updateProfile(expertInput: ExpertInput!): UpdateProfileResult!

    """
    Submit a seeker review for a session.
    """
    submitReview(reviewInput: ReviewInput!): SubmitReviewResult!

    """
    Register as an expert. Requires valid wallet signature in headers.
    """
    registerExpert(
      name: String!
      bio: String
      skills: [String!]
      hourlyRate: Float
    ): UpdateProfileResult!
  }
`;
