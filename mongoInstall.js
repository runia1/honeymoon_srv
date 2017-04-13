/**
 * Created by mar on 3/17/17.
 */

mongo
use admin
db.createUser(
    {
        user: "root",
        pwd: "rootpwd",
        roles: [ { role: "userAdminAnyDatabase", db: "admin" } ]
    }
)
ctrl-c

mongo -u "root" -p "rootpwd" --authenticationDatabase "admin"

use honeymoon
db.createUser({user: "honeymoon", pwd: "pwd", roles: [{role: "dbOwner", db: "honeymoon"}]})

db.createCollection("gifts")

// users
const users = {
    ip: '',
    ctime: '',
    nickname: ''
};

// gifts
const gifts = {
    userId: '',
    amount: '',
    comment: '',
    registryId: ''
};

// registry
const registry = {
    title: '',
    description: '',
    totalPrice: '',
    totalGiven: '',
    goalReached: '',
    
};