# Admin Panel User Management Guide

## 🔐 Setting Up Admin Access

### Step 1: Create Your Admin Account
1. Go to Firebase Console → Authentication
2. Create a user account with your email
3. Copy the **User UID** from the Authentication page

### Step 2: Mark Yourself as Admin
1. Go to Firebase Console → Firestore Database
2. Go to the `users` collection
3. Find your user document (by UID)
4. Add a new field:
   - **Field name**: `role`
   - **Field type**: string
   - **Field value**: `admin`
5. Save the document

### Step 3: Access Admin Panel
1. Navigate to `/admin.html` on your website
2. Log in with your admin account
3. You'll now have full access to the admin panel

---

## 📊 Admin Panel Features

### Dashboard Overview
- **Total Users**: Number of users in the system
- **Complete Profiles**: Users who have finished onboarding
- **Google Sign-In**: Users using Google authentication

### Add New Users
1. Click "Add New User" section
2. Enter user's email address
3. Set a temporary password (min. 6 characters)
4. Optionally add their full name
5. Click "Add User"

**Important**: After adding a user through the admin panel, you must:
1. Go to Firebase Console → Authentication
2. Manually create the auth user with the same email
3. Set the password you specified
4. User can then log in with email/password OR Google

### Manage Existing Users
- **View all users** in a clean table format
- **See user details**:
  - Email address
  - Display name
  - Profile completion status
  - Sign-in method (email or Google)
- **View individual users** by clicking "View" button

---

## 🔧 How User Access Works

### Email/Password Users
1. You create user in admin panel (or Firebase Console)
2. Set temporary password
3. User logs in → completes profile → accesses dashboard

### Google Sign-In Users
1. User tries to sign in with Google
2. System checks if user exists in Firestore
3. **If exists**: Grants access → redirects to dashboard
4. **If NOT exists**: Denies access → shows error message

**To allow Google users**:
1. Create user in Firebase Authentication with their email
2. Create Firestore document in `users` collection
3. Add required fields: `email`, `signInMethod`, `profileComplete`
4. User can now sign in with Google

---

## 🚀 Best Practices

### Adding New Members
1. **Collect their email** first
2. **Create auth user** in Firebase Console:
   - Go to Authentication → Add user
   - Enter email
   - Set temporary password (share securely)
3. **Add to Firestore** (optional - will be auto-created on first login)
4. **Share login credentials** via secure method
5. **User logs in** → completes profile → ready to use

### Security Tips
- ✅ Keep admin role limited to trusted personnel
- ✅ Use strong passwords for admin accounts
- ✅ Regularly audit user list
- ✅ Remove access for users who leave
- ✅ Never share admin credentials

---

## 📝 User Document Structure

Each user in Firestore has this structure:

```javascript
{
  email: "user@example.com",
  displayName: "John Doe",
  photoURL: "https://...", // For Google users
  role: "user", // or "admin"
  signInMethod: "email", // or "google"
  profileComplete: false, // true after onboarding
  createdAt: "2025-01-15T10:30:00Z"
}
```

### Admin Users
To make someone an admin, add:
```javascript
{
  role: "admin"
}
```

---

## 🐛 Troubleshooting

### "Access denied. Admin privileges required"
**Solution**: Make sure your user document has `role: "admin"` in Firestore

### User can't log in after being added
**Solution**: Check Firebase Authentication - user must exist there too

### Google Sign-In shows "No account found"
**Solution**: Create user in Firebase Authentication first, then they can use Google

### Admin panel won't load
**Solution**: 
1. Make sure you're logged in
2. Verify you have admin role
3. Check browser console for errors

---

## 🔄 Workflow Example

### Adding a New Client:

1. **Client signs up** → You get their email: `client@example.com`

2. **Create in Firebase Console**:
   ```
   Authentication → Add user
   Email: client@example.com
   Password: TempPass123!
   ```

3. **Send credentials** (secure email/message):
   ```
   Welcome to Blue Chip Signals!
   
   Login: https://yoursite.com/login.html
   Email: client@example.com
   Password: TempPass123!
   
   Please change your password after first login.
   ```

4. **Client logs in**:
   - Enters email/password OR uses Google Sign-In
   - Completes profile on welcome page
   - Gets access to dashboard

5. **Verify in Admin Panel**:
   - Check user appears in list
   - Profile status shows "Complete"

---

## 📞 Support

If you need help:
1. Check Firebase Console for errors
2. Review browser console logs
3. Verify user exists in both Authentication and Firestore
4. Ensure admin role is set correctly

---

## 🎯 Quick Reference

| Task | Location |
|------|----------|
| Add Admin Role | Firestore → users → {uid} → add `role: "admin"` |
| Create Auth User | Firebase Console → Authentication → Add user |
| View All Users | Admin Panel → Manage Users section |
| Check User Details | Admin Panel → Click "View" button |
| Remove Access | Firebase Console → Authentication → Delete user |

---

**Last Updated**: January 2025

