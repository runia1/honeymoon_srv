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
    ctime: '',
    nickname: ''
};

// gifts
const gifts = {
    userId: ObjectId("58f12e493c688212a130c73b"),
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